import { spawn } from "node:child_process";
import { join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { podmanEnv } from "@cocalc/backend/podman/env";
import { getGeneration } from "@cocalc/file-server/btrfs/subvolume-snapshots";
import { listProjects, upsertProject } from "./sqlite/projects";
import {
  resetProjectLastEditedRunning,
  shouldCheckProjectLastEditedRunning,
  touchProjectLastEditedRunning,
} from "./last-edited";
import { getMountPoint } from "./file-server";

const DEFAULT_INTERVAL = 15_000;
const DEFAULT_MISSING_CYCLES_BEFORE_OPENED = 2;

const logger = getLogger("project-host:reconcile");
const missingSince = new Map<string, number>();

interface ContainerState {
  project_id: string;
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
    } else if (http_port == null || container === 8080 || container === 80) {
      // Project containers always publish SSH on 22 and their main HTTP proxy
      // on one non-SSH TCP port (currently 8080). Preserve compatibility with
      // any older 80/tcp layouts, but otherwise treat the first non-22 tcp
      // mapping as the project HTTP port.
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
      ["ps", "-a", "--format", "{{.Names}}|{{.State}}|{{.Ports}}"],
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
        if (parts.length < 2) continue;
        const name = parts[0]?.trim();
        const stateRaw = parts[1]?.trim().toLowerCase();
        const portsRaw = parts[2]?.trim();
        const m = name.match(/^project-([0-9a-fA-F-]{36})$/);
        if (!m) continue;
        const project_id = m[1];
        const state: "running" | "opened" =
          stateRaw && stateRaw.startsWith("running") ? "running" : "opened";
        const { http_port, ssh_port } = parsePorts(portsRaw);
        states.set(project_id, { project_id, state, http_port, ssh_port });
      }
      resolve({ ok: true, states });
    });
  });
}

export async function reconcileOnce() {
  const now = Date.now();
  const knownProjects = listProjects();
  const knownIds = new Set(knownProjects.map((p) => p.project_id));
  const { ok, states: containers } = await getContainerStates();
  if (!ok) {
    logger.debug(
      "skipping reconcile state downgrade after failed podman probe",
      {
        known_projects: knownProjects.length,
      },
    );
    return;
  }
  let mountPoint: string | undefined;
  let mountPointError: string | undefined;
  let loggedMountPointError = false;
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
    if (!knownIds.has(info.project_id)) continue;
    missingSince.delete(info.project_id);
    upsertProject({
      project_id: info.project_id,
      state: info.state,
      http_port: info.http_port ?? null,
      ssh_port: info.ssh_port ?? null,
      updated_at: now,
      last_seen: now,
    });
    if (info.state === "running") {
      if (shouldCheckProjectLastEditedRunning(info.project_id)) {
        const base = resolveMountPoint();
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
          await touchProjectLastEditedRunning(info.project_id, generation);
        } catch (err) {
          logger.debug("running generation check failed", {
            project_id: info.project_id,
            err: `${err}`,
          });
        }
      }
    } else {
      resetProjectLastEditedRunning(info.project_id);
    }
  }

  // Any project we think is active but has no container should be marked stopped.
  for (const row of knownProjects) {
    if (
      !containers.has(row.project_id) &&
      (row.state === "running" || row.state === "starting")
    ) {
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
      upsertProject({
        project_id: row.project_id,
        state: "opened",
        http_port: null,
        ssh_port: null,
        updated_at: now,
        last_seen: now,
      });
      resetProjectLastEditedRunning(row.project_id);
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

export function resetReconcileStateForTests(): void {
  missingSince.clear();
}

export function startReconciler(intervalMs = DEFAULT_INTERVAL): () => void {
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    try {
      await reconcileOnce();
    } catch (err) {
      logger.debug("reconcileOnce failed", { err: `${err}` });
    }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref();
  tick().catch((err) =>
    logger.debug("initial reconcile failed", { err: `${err}` }),
  );
  return () => timer && clearInterval(timer);
}
