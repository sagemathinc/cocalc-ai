import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { getConmonContainerProcesses } from "@cocalc/backend/podman/conmon";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { getGeneration } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import { DEFAULT_PROJECT_PROXY_PORT } from "@cocalc/project-runner/run/env";
import { pidFilename, pidUpdateIntervalMs } from "@cocalc/util/project-info";
import {
  getProject,
  listProjectsByStates,
  upsertProject,
} from "./sqlite/projects";
import {
  markProjectLastChangedRunning,
  resetProjectLastChangedRunning,
  shouldCheckProjectLastChangedRunning,
} from "./last-edited";
import { getMountPoint } from "./file-server";
import { reportProjectStateImmediately } from "./project-state-reporter";
import { withProjectRuntimeLifecycle } from "./runtime-lifecycle";

const DEFAULT_INTERVAL = 15_000;
const DEFAULT_MISSING_CYCLES_BEFORE_OPENED = 2;
const DEFAULT_STALE_HEARTBEAT_MS = pidUpdateIntervalMs * 2.5;
const DEFAULT_STALE_HEARTBEAT_CYCLES = 3;
const DEFAULT_CGROUP_AUDIT_INTERVAL_MS = 6 * 60 * 60_000;
const DEFAULT_CGROUP_RETRY_MS = 5 * 60_000;
// The privileged helper serializes cgroup hierarchy mutations globally. More
// concurrency only creates lock waiters and can starve foreground project
// starts while a large host is repairing every running project at startup.
const DEFAULT_CGROUP_RECONCILE_CONCURRENCY = 1;
// A large host can have hundreds of running containers. Even serialized
// repairs issue a Podman inspection per project, so bound each tick to avoid
// starving foreground container creation with a startup inspection burst.
const DEFAULT_CGROUP_RECONCILE_MAX_PER_TICK = 4;
const DEFAULT_NETWORK_RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_PROJECT_PROXY_PORT_NUMBER = Number(DEFAULT_PROJECT_PROXY_PORT);

const logger = getLogger("project-host:reconcile");
const missingSince = new Map<string, number>();
const staleHeartbeatCycles = new Map<string, number>();
const cgroupReconciledState = new Map<
  string,
  { signature: string; audited_at: number; retry_at?: number }
>();
let networkReconciledAt = 0;

export interface ReconcileOptions {
  reconcileProjectCgroup?: (opts: {
    project_id: string;
    run_quota?: any;
    force: boolean;
  }) => Promise<{ status: string }>;
  reconcileProjectNetworkLimits?: () => Promise<void>;
  forceProjectCgroupRepair?: boolean;
}

interface ContainerState {
  project_id: string;
  container_id?: string;
  state: "running" | "opened";
  http_port?: number | null;
  ssh_port?: number | null;
}

interface ContainerProbeResult {
  ok: boolean;
  states: Map<string, ContainerState>;
}

function parsePorts(ports?: string): {
  http_port?: number | null;
  ssh_port?: number | null;
} {
  if (!ports) return {};
  let http_port: number | null | undefined;
  let ssh_port: number | null | undefined;
  for (const entry of ports.split(",").map((s) => s.trim())) {
    if (!entry) continue;
    const match = entry.match(/:([0-9]+)->([0-9]+)\/tcp/);
    if (!match) continue;
    const host = Number(match[1]);
    const container = Number(match[2]);
    if (Number.isNaN(host) || Number.isNaN(container)) continue;
    if (container === 22) {
      ssh_port = host;
    } else if (
      http_port == null ||
      container === DEFAULT_PROJECT_PROXY_PORT_NUMBER
    ) {
      // Project containers publish SSH on 22 and the project HTTP proxy on a
      // non-SSH TCP port. Prefer the configured proxy port when present, but
      // otherwise fall back to the first non-22 mapping we observe rather than
      // guessing from legacy user-visible ports like 8080.
      http_port = host;
    }
  }
  return { http_port, ssh_port };
}

export async function getContainerStates(): Promise<ContainerProbeResult> {
  return await new Promise<ContainerProbeResult>((resolve) => {
    const states = new Map<string, ContainerState>();
    let env: NodeJS.ProcessEnv;
    try {
      env = podmanEnv();
    } catch (err) {
      logger.debug("podman probe env unavailable", { err: `${err}` });
      resolve({ ok: false, states });
      return;
    }
    const child = spawn(
      "podman",
      ["ps", "-a", "--format", "{{.Names}}|{{.ID}}|{{.State}}|{{.Ports}}"],
      {
        env,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      logger.debug("podman ps failed", { err: `${err}` });
      resolve({ ok: false, states });
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        logger.debug("podman ps exited non-zero", {
          code,
          stderr: stderr.trim(),
        });
        return resolve({ ok: false, states });
      }
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length < 3) continue;
        const name = parts[0]?.trim();
        // Accept the previous three-field format while old hosts and focused
        // tests are rolling forward, but use container identity whenever the
        // new four-field probe is available.
        const hasContainerId = parts.length >= 4;
        const container_id = hasContainerId
          ? parts[1]?.trim() || undefined
          : undefined;
        const stateRaw = parts[hasContainerId ? 2 : 1]?.trim().toLowerCase();
        const portsRaw = parts[hasContainerId ? 3 : 2]?.trim();
        const m = name.match(/^project-([0-9a-fA-F-]{36})$/);
        if (!m) continue;
        const project_id = m[1];
        const state: "running" | "opened" =
          stateRaw && stateRaw.startsWith("running") ? "running" : "opened";
        const { http_port, ssh_port } = parsePorts(portsRaw);
        states.set(project_id, {
          project_id,
          container_id,
          state,
          http_port,
          ssh_port,
        });
      }
      getConmonContainerProcesses()
        .then((conmonStates) => {
          for (const info of conmonStates.values()) {
            const project_id = info.project_id;
            if (!project_id) continue;
            if (states.has(project_id)) continue;
            logger.warn(
              "podman did not report a live project container; falling back to conmon process state",
              { project_id },
            );
            states.set(project_id, { project_id, state: "running" });
          }
          resolve({ ok: true, states });
        })
        .catch(() => resolve({ ok: true, states }));
    });
  });
}

function projectHeartbeatAgeMs(
  mountPoint: string,
  project_id: string,
  now: number,
): number | undefined {
  try {
    const heartbeatPath = join(
      mountPoint,
      `project-${project_id}`,
      ".cache",
      "cocalc",
      "project",
      pidFilename,
    );
    const mtimeMs = statSync(heartbeatPath).mtimeMs;
    return Number.isFinite(mtimeMs) ? Math.max(0, now - mtimeMs) : undefined;
  } catch {
    return undefined;
  }
}

async function reportRuntimeLost(project_id: string, now: number) {
  await withProjectRuntimeLifecycle({
    project_id,
    allow_unversioned: true,
    fn: async () => {
      const current = getProject(project_id);
      if (current?.state !== "running" && current?.state !== "starting") return;
      // The inventory may predate a queued start. Recheck under the same lock
      // used by start/stop before fencing work belonging to this project.
      const probe = await getContainerStates();
      if (!probe.ok || probe.states.get(project_id)?.state === "running")
        return;
      const { pauseHarnessDiscovery } =
        await import("@cocalc/lite/hub/acp/harness-runtime");
      const resumeDiscovery = pauseHarnessDiscovery(project_id);
      try {
        const { fenceProjectHostAcpWork } =
          await import("./hub/acp/worker-manager");
        await fenceProjectHostAcpWork({ project_id });
        recordRuntimeLost(project_id, now);
      } finally {
        resumeDiscovery();
      }
    },
  });
}

function recordRuntimeLost(project_id: string, now: number) {
  cgroupReconciledState.delete(project_id);
  staleHeartbeatCycles.delete(project_id);
  upsertProject({
    project_id,
    state: "opened",
    runtime_exit_reason: "container_missing",
    http_port: null,
    ssh_port: null,
    updated_at: now,
    last_seen: now,
  });
  void reportProjectStateImmediately(project_id, {
    state: "opened",
    time: new Date(now),
    runtime_exit_reason: "container_missing",
  }).catch((err) =>
    logger.debug("immediate runtime-loss report failed", {
      project_id,
      err: `${err}`,
    }),
  );
  resetProjectLastChangedRunning(project_id);
}

export async function reconcileOnce(options: ReconcileOptions = {}) {
  const now = Date.now();
  const activeProjects = listProjectsByStates(["running", "starting"]);
  const knownById = new Map(activeProjects.map((p) => [p.project_id, p]));
  const { ok, states: containers } = await getContainerStates();
  if (!ok) {
    logger.debug(
      "skipping reconcile state downgrade after failed podman probe",
      {
        active_projects: activeProjects.length,
      },
    );
    return;
  }
  let mountPoint: string | undefined;
  let mountPointError: string | undefined;
  let loggedMountPointError = false;
  const cgroupRepairs: Array<() => Promise<void>> = [];
  const resolveMountPoint = (): string | undefined => {
    if (mountPoint || mountPointError) return mountPoint;
    try {
      mountPoint = getMountPoint();
    } catch (err) {
      mountPointError = `${err}`;
    }
    return mountPoint;
  };
  // Update rows for containers we see that belong to this host (ignore other hosts on same machine).
  for (const info of containers.values()) {
    const known = knownById.get(info.project_id) ?? getProject(info.project_id);
    if (!known) continue;
    knownById.set(info.project_id, known);
    missingSince.delete(info.project_id);
    if (
      info.state === "opened" &&
      (known.state === "running" || known.state === "starting")
    ) {
      await reportRuntimeLost(info.project_id, now);
      continue;
    }
    const row: any = {
      project_id: info.project_id,
      state: info.state,
      updated_at: now,
      last_seen: now,
    };
    if (info.http_port !== undefined) {
      row.http_port = info.http_port ?? null;
    }
    if (info.ssh_port !== undefined) {
      row.ssh_port = info.ssh_port ?? null;
    }
    upsertProject(row);
    if (info.state === "running") {
      if (options.reconcileProjectCgroup != null) {
        const known = knownById.get(info.project_id);
        const policySignature = JSON.stringify({
          container_id: info.container_id ?? null,
          run_quota_revision: Number(known?.run_quota_revision) || 0,
          run_quota: known?.run_quota ?? null,
        });
        const lastReconciled = cgroupReconciledState.get(info.project_id);
        const due =
          options.forceProjectCgroupRepair === true ||
          lastReconciled?.signature !== policySignature ||
          (lastReconciled?.retry_at != null
            ? now >= lastReconciled.retry_at
            : now - (lastReconciled?.audited_at ?? 0) >=
              cgroupAuditIntervalMs());
        if (due && cgroupRepairs.length < cgroupReconcileMaxPerTick()) {
          // Record the attempt before starting it. A timed-out privileged helper
          // must not be queued again by every 15-second reconcile tick.
          cgroupReconciledState.set(info.project_id, {
            signature: policySignature,
            audited_at: now,
          });
          const run_quota = known?.run_quota;
          cgroupRepairs.push(async () => {
            try {
              const result = await options.reconcileProjectCgroup!({
                project_id: info.project_id,
                run_quota,
                force: options.forceProjectCgroupRepair === true,
              });
              if (result.status === "repaired") {
                logger.info("repaired project cgroup policy", {
                  project_id: info.project_id,
                });
              } else if (result.status === "not_running") {
                cgroupReconciledState.delete(info.project_id);
              }
            } catch (err) {
              if (
                cgroupReconciledState.get(info.project_id)?.signature ===
                policySignature
              ) {
                cgroupReconciledState.set(info.project_id, {
                  signature: policySignature,
                  audited_at: now,
                  retry_at: now + cgroupRetryMs(),
                });
              }
              logger.warn("project cgroup reconciliation failed", {
                project_id: info.project_id,
                err: `${err}`,
              });
            }
          });
        }
      }
      const base = resolveMountPoint();
      const heartbeatAgeMs = base
        ? projectHeartbeatAgeMs(base, info.project_id, now)
        : undefined;
      if (
        heartbeatAgeMs != null &&
        heartbeatAgeMs <= staleProjectHeartbeatMs()
      ) {
        staleHeartbeatCycles.delete(info.project_id);
      } else if (base != null) {
        const cycles = (staleHeartbeatCycles.get(info.project_id) ?? 0) + 1;
        staleHeartbeatCycles.set(info.project_id, cycles);
        if (cycles === staleProjectHeartbeatCycles()) {
          logger.warn(
            "running project daemon heartbeat is stale; preserving container",
            {
              project_id: info.project_id,
              heartbeat_age_ms: heartbeatAgeMs,
              stale_after_ms: staleProjectHeartbeatMs(),
              stale_cycles: cycles,
              action: "none",
            },
          );
        }
      }
      if (shouldCheckProjectLastChangedRunning(info.project_id)) {
        if (!base) {
          if (mountPointError && !loggedMountPointError) {
            logger.debug("running generation check skipped (no mountpoint)", {
              err: mountPointError,
            });
            loggedMountPointError = true;
          }
          continue;
        }
        try {
          const projectPath = join(base, `project-${info.project_id}`);
          const generation = await getGeneration(projectPath);
          markProjectLastChangedRunning(info.project_id, generation);
        } catch (err) {
          logger.debug("running generation check failed", {
            project_id: info.project_id,
            err: `${err}`,
          });
        }
      }
    } else {
      cgroupReconciledState.delete(info.project_id);
      staleHeartbeatCycles.delete(info.project_id);
      resetProjectLastChangedRunning(info.project_id);
    }
  }

  await runWithConcurrency(cgroupRepairs, cgroupReconcileConcurrency());

  if (options.reconcileProjectNetworkLimits != null) {
    const due =
      options.forceProjectCgroupRepair === true ||
      now - networkReconciledAt >= networkReconcileIntervalMs();
    if (due) {
      // As with per-project cgroups, failed attempts are rate limited. The next
      // pass repairs the complete host policy in one transaction.
      networkReconciledAt = now;
      try {
        await options.reconcileProjectNetworkLimits();
      } catch (err) {
        logger.warn("project network containment reconciliation failed", {
          err: `${err}`,
        });
      }
    }
  }

  // Any project we think is active but has no container should be marked stopped.
  for (const row of activeProjects) {
    if (
      !containers.has(row.project_id) &&
      (row.state === "running" || row.state === "starting")
    ) {
      cgroupReconciledState.delete(row.project_id);
      const misses = (missingSince.get(row.project_id) ?? 0) + 1;
      missingSince.set(row.project_id, misses);
      if (misses < missingCyclesBeforeOpened()) {
        logger.debug(
          "reconcile saw running project without container; delaying downgrade",
          {
            project_id: row.project_id,
            previous_state: row.state,
            misses,
            required_misses: missingCyclesBeforeOpened(),
          },
        );
        continue;
      }
      staleHeartbeatCycles.delete(row.project_id);
      await reportRuntimeLost(row.project_id, now);
    }
  }
}

function missingCyclesBeforeOpened(): number {
  const raw = Number(process.env.COCALC_PROJECT_HOST_RECONCILE_MISSING_CYCLES);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_MISSING_CYCLES_BEFORE_OPENED;
  }
  return Math.max(1, Math.floor(raw));
}

function staleProjectHeartbeatMs(): number {
  const raw = Number(
    process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_MS,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STALE_HEARTBEAT_MS;
  }
  return Math.max(pidUpdateIntervalMs, Math.floor(raw));
}

function staleProjectHeartbeatCycles(): number {
  const raw = Number(
    process.env.COCALC_PROJECT_HOST_RECONCILE_STALE_HEARTBEAT_CYCLES,
  );
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_STALE_HEARTBEAT_CYCLES;
  }
  return Math.max(1, Math.floor(raw));
}

function cgroupAuditIntervalMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_CGROUP_AUDIT_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CGROUP_AUDIT_INTERVAL_MS;
  }
  return Math.max(DEFAULT_INTERVAL, Math.floor(raw));
}

function cgroupRetryMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_CGROUP_RETRY_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CGROUP_RETRY_MS;
  }
  return Math.max(DEFAULT_INTERVAL, Math.floor(raw));
}

function cgroupReconcileConcurrency(): number {
  const raw = Number(process.env.COCALC_PROJECT_CGROUP_RECONCILE_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CGROUP_RECONCILE_CONCURRENCY;
  }
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

function cgroupReconcileMaxPerTick(): number {
  const raw = Number(process.env.COCALC_PROJECT_CGROUP_RECONCILE_MAX_PER_TICK);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CGROUP_RECONCILE_MAX_PER_TICK;
  }
  return Math.max(1, Math.min(128, Math.floor(raw)));
}

function networkReconcileIntervalMs(): number {
  const raw = Number(process.env.COCALC_PROJECT_NETWORK_RECONCILE_INTERVAL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_NETWORK_RECONCILE_INTERVAL_MS;
  }
  return Math.max(DEFAULT_INTERVAL, Math.floor(raw));
}

async function runWithConcurrency(
  jobs: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++;
        await jobs[index]();
      }
    }),
  );
}

export function resetReconcileStateForTests(): void {
  missingSince.clear();
  staleHeartbeatCycles.clear();
  cgroupReconciledState.clear();
  networkReconciledAt = 0;
}

export function startReconciler(
  intervalMs = DEFAULT_INTERVAL,
  options: ReconcileOptions = {},
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let first = true;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await reconcileOnce({
        ...options,
        forceProjectCgroupRepair:
          first || options.forceProjectCgroupRepair === true,
      });
    } catch (err) {
      logger.debug("reconcileOnce failed", { err: `${err}` });
    } finally {
      first = false;
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  tick().catch((err) =>
    logger.debug("initial reconcile failed", { err: `${err}` }),
  );
  return () => timer && clearInterval(timer);
}
