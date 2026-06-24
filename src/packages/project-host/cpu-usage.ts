/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readdir, readFile } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { podman } from "@cocalc/backend/podman";
import { hubApi } from "@cocalc/lite/hub/api";
import { isProjectHostCpuUsageTrackingEnabled } from "./cpu-usage-runtime";

const logger = getLogger("project-host:cpu-usage");

const DEFAULT_INTERVAL_MS = 60_000;
const MAX_DELTA_CPU_SECONDS = 24 * 60 * 60 * 256;
const STOP_COOLDOWN_MS = 5 * 60_000;

type PodmanLike = (
  args: string[],
) => Promise<{ stdout?: string; stderr?: string; exit_code?: number }>;

type ReadFileLike = (path: string, encoding: BufferEncoding) => Promise<string>;
type ReaddirLike = (path: string) => Promise<string[]>;

type ProjectContainer = {
  id: string;
  name: string;
  project_id: string;
};

export type ProjectCpuSample = {
  project_id: string;
  container_id: string;
  pid: number;
  runtime_key: string;
  source: "proc-tree";
  cgroup_version?: "v1" | "v2";
  cgroup_path?: string;
  cpu_seconds_total: number;
  cpu_cores_limit?: number;
};

export type ProjectCpuDelta = ProjectCpuSample & {
  cpu_seconds: number;
};

function envPositiveInt(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function normalizeProjectContainerName(name: unknown): string | undefined {
  const value = `${name ?? ""}`.trim().replace(/^\/+/, "");
  if (!value) return;
  return value;
}

function projectIdFromContainerName(
  name: string | undefined,
): string | undefined {
  const match = name?.match(/^project-([0-9a-fA-F-]{36})$/);
  return match?.[1];
}

async function listRunningProjectContainers(
  podmanCommand: PodmanLike,
): Promise<ProjectContainer[]> {
  const ps = await podmanCommand(["ps", "--format", "json"]);
  const parsed = `${ps.stdout ?? ""}`.trim()
    ? JSON.parse(`${ps.stdout ?? ""}`)
    : [];
  const out: ProjectContainer[] = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const id = `${row?.Id ?? row?.ID ?? ""}`.trim();
    const names = Array.isArray(row?.Names)
      ? row.Names
      : [row?.Names ?? row?.Name ?? row?.Names0];
    const name = normalizeProjectContainerName(names.find(Boolean));
    const project_id = projectIdFromContainerName(name);
    if (!id || !name || !project_id) continue;
    out.push({ id, name, project_id });
  }
  return out;
}

async function inspectProjectContainerPids(
  containers: ProjectContainer[],
  podmanCommand: PodmanLike,
): Promise<Array<ProjectContainer & { pid: number }>> {
  if (containers.length === 0) return [];
  const inspect = await podmanCommand([
    "inspect",
    ...containers.map((container) => container.id),
    "--format",
    "json",
  ]);
  const parsed = `${inspect.stdout ?? ""}`.trim()
    ? JSON.parse(`${inspect.stdout ?? ""}`)
    : [];
  const byName = new Map(
    containers.map((container) => [container.name, container]),
  );
  const out: Array<ProjectContainer & { pid: number }> = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const name = normalizeProjectContainerName(row?.Name);
    const container = name ? byName.get(name) : undefined;
    const pid = Number(row?.State?.Pid);
    if (!container || !Number.isInteger(pid) || pid <= 0) continue;
    out.push({ ...container, pid });
  }
  return out;
}

function parseProcCgroup(
  content: string,
): { version: "v1" | "v2"; path: string } | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(":");
    if (parts.length < 3) continue;
    const controllers = parts[1] ?? "";
    const path = parts.slice(2).join(":") || "/";
    if (parts[0] === "0" && controllers === "") {
      return { version: "v2", path };
    }
    const controllerList = controllers.split(",");
    if (controllerList.includes("cpuacct") || controllerList.includes("cpu")) {
      return { version: "v1", path };
    }
  }
}

function cgroupFilePath({
  version,
  path,
}: {
  version: "v1" | "v2";
  path: string;
}): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  if (version === "v2") {
    return `/sys/fs/cgroup${cleanPath}/cpu.stat`;
  }
  return `/sys/fs/cgroup/cpu,cpuacct${cleanPath}/cpuacct.usage`;
}

function parseCpuSeconds({
  version,
  content,
}: {
  version: "v1" | "v2";
  content: string;
}): number | undefined {
  if (version === "v2") {
    const usageUsec = content.match(/(?:^|\n)usage_usec\s+(\d+)/)?.[1];
    if (!usageUsec) return;
    return Number(usageUsec) / 1_000_000;
  }
  const usageNsec = Number(content.trim());
  if (!Number.isFinite(usageNsec)) return;
  return usageNsec / 1_000_000_000;
}

type ProcessCpuSnapshot = {
  childrenByParent: Map<number, number[]>;
  cpuTicksByPid: Map<number, number>;
};

function clockTicksPerSecond(): number {
  const raw = Number(process.env.COCALC_PROC_CLK_TCK);
  return Number.isFinite(raw) && raw > 0 ? raw : 100;
}

function parseProcStat(
  content: string,
): { ppid: number; cpuTicks: number } | undefined {
  const closeParen = content.lastIndexOf(")");
  if (closeParen < 0) return;
  const fields = content
    .slice(closeParen + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (
    !Number.isInteger(ppid) ||
    !Number.isFinite(utime) ||
    !Number.isFinite(stime)
  ) {
    return;
  }
  return { ppid, cpuTicks: utime + stime };
}

async function collectProcessCpuSnapshot({
  readdirFn,
  readFileFn,
}: {
  readdirFn: ReaddirLike;
  readFileFn: ReadFileLike;
}): Promise<ProcessCpuSnapshot> {
  const childrenByParent = new Map<number, number[]>();
  const cpuTicksByPid = new Map<number, number>();
  const entries = await readdirFn("/proc");
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return;
      const pid = Number(entry);
      try {
        const stat = parseProcStat(
          await readFileFn(`/proc/${entry}/stat`, "utf8"),
        );
        if (!stat) return;
        cpuTicksByPid.set(pid, stat.cpuTicks);
        const children = childrenByParent.get(stat.ppid) ?? [];
        children.push(pid);
        childrenByParent.set(stat.ppid, children);
      } catch {
        // Processes can exit while we are walking /proc.
      }
    }),
  );
  return { childrenByParent, cpuTicksByPid };
}

function sumProcessTreeCpuTicks(
  rootPid: number,
  snapshot: ProcessCpuSnapshot,
): number | undefined {
  if (!snapshot.cpuTicksByPid.has(rootPid)) return;
  let total = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += snapshot.cpuTicksByPid.get(pid) ?? 0;
    for (const child of snapshot.childrenByParent.get(pid) ?? []) {
      stack.push(child);
    }
  }
  return total;
}

async function getProjectCpuSample({
  container,
  processSnapshot,
}: {
  container: ProjectContainer & { pid: number };
  processSnapshot: ProcessCpuSnapshot;
}): Promise<ProjectCpuSample | undefined> {
  const cpuTicks = sumProcessTreeCpuTicks(container.pid, processSnapshot);
  if (cpuTicks == null) return;
  const cpu_seconds_total = cpuTicks / clockTicksPerSecond();
  if (!Number.isFinite(cpu_seconds_total) || (cpu_seconds_total ?? 0) < 0) {
    return;
  }
  const runtime_key = `${container.id}:proc-tree:${container.pid}`;
  return {
    project_id: container.project_id,
    container_id: container.id,
    pid: container.pid,
    runtime_key,
    source: "proc-tree",
    cpu_seconds_total: cpu_seconds_total ?? 0,
  };
}

export async function collectRunningProjectCpuSamples({
  podmanCommand = podman,
  readdirFn = readdir,
  readFileFn = readFile,
}: {
  podmanCommand?: PodmanLike;
  readdirFn?: ReaddirLike;
  readFileFn?: ReadFileLike;
} = {}): Promise<ProjectCpuSample[]> {
  const containers = await listRunningProjectContainers(podmanCommand);
  const inspected = await inspectProjectContainerPids(
    containers,
    podmanCommand,
  );
  const processSnapshot = await collectProcessCpuSnapshot({
    readdirFn,
    readFileFn,
  });
  const samples = await Promise.all(
    inspected.map(async (container) => {
      try {
        return await getProjectCpuSample({ container, processSnapshot });
      } catch (err) {
        logger.debug("unable to sample project CPU counter", {
          project_id: container.project_id,
          pid: container.pid,
          err: `${err}`,
        });
      }
    }),
  );
  return samples
    .filter((sample): sample is ProjectCpuSample => !!sample)
    .sort((a, b) => a.runtime_key.localeCompare(b.runtime_key));
}

export function summarizeManagedCpuUsageDeltas({
  previous,
  current,
}: {
  previous: Map<string, ProjectCpuSample>;
  current: Map<string, ProjectCpuSample>;
}): ProjectCpuDelta[] {
  const out: ProjectCpuDelta[] = [];
  for (const [runtimeKey, sample] of current) {
    const prev = previous.get(runtimeKey);
    if (!prev) continue;
    if (sample.cpu_seconds_total < prev.cpu_seconds_total) continue;
    const cpu_seconds = sample.cpu_seconds_total - prev.cpu_seconds_total;
    if (!(cpu_seconds > 0) || cpu_seconds > MAX_DELTA_CPU_SECONDS) continue;
    out.push({
      ...sample,
      cpu_seconds,
    });
  }
  return out.sort((a, b) => a.runtime_key.localeCompare(b.runtime_key));
}

export function startManagedCpuUsageLoop({
  intervalMs = envPositiveInt(
    "COCALC_PROJECT_HOST_CPU_USAGE_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  ),
  sample = collectRunningProjectCpuSamples,
}: {
  intervalMs?: number;
  sample?: typeof collectRunningProjectCpuSamples;
} = {}): () => void {
  let previous = new Map<string, ProjectCpuSample>();
  let previousSampleAt: number | undefined;
  const recentStops = new Map<string, number>();
  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      if (!isProjectHostCpuUsageTrackingEnabled()) {
        return;
      }
      const sampledAt = Date.now();
      const currentSamples = await sample();
      const current = new Map(
        currentSamples.map((entry) => [entry.runtime_key, entry] as const),
      );
      const deltas = summarizeManagedCpuUsageDeltas({ previous, current });
      previous = current;
      const sample_started_at =
        previousSampleAt == null ? undefined : new Date(previousSampleAt);
      previousSampleAt = sampledAt;

      if (deltas.length > 0) {
        logger.info("managed CPU usage sample", {
          projects: deltas.map((delta) => ({
            project_id: delta.project_id,
            cpu_seconds: delta.cpu_seconds,
            container_id: delta.container_id,
            pid: delta.pid,
            cgroup_version: delta.cgroup_version,
          })),
        });
      }
      for (const delta of deltas) {
        try {
          const result = await hubApi.system.recordManagedProjectCpuUsage({
            project_id: delta.project_id,
            cpu_seconds: delta.cpu_seconds,
            sample_started_at,
            sample_ended_at: new Date(sampledAt),
            metadata: {
              container_id: delta.container_id,
              pid: delta.pid,
              runtime_key: delta.runtime_key,
              source: delta.source,
              cgroup_version: delta.cgroup_version,
              cgroup_path: delta.cgroup_path,
              interval_ms:
                sample_started_at == null
                  ? undefined
                  : sampledAt - sample_started_at.getTime(),
              mode: "project-host-proc-tree-v1",
            },
          });
          if (result?.stop_project) {
            const lastStoppedAt = recentStops.get(delta.project_id) ?? 0;
            if (sampledAt - lastStoppedAt > STOP_COOLDOWN_MS) {
              recentStops.set(delta.project_id, sampledAt);
              logger.warn("stopping project after managed CPU quota exceeded", {
                project_id: delta.project_id,
                account_id: result.account_id,
                blocked_by: result.stop_project.blocked_by,
                membership_class: result.stop_project.membership_class,
                membership_source: result.stop_project.membership_source,
              });
              await hubApi.projects.stop({
                project_id: delta.project_id,
              });
            }
          }
        } catch (err) {
          logger.warn("unable to record project CPU usage", {
            project_id: delta.project_id,
            cpu_seconds: delta.cpu_seconds,
            err: `${err}`,
          });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  void runOnce();
  return () => clearInterval(timer);
}

export const __test__ = {
  cgroupFilePath,
  parseCpuSeconds,
  parseProcStat,
  parseProcCgroup,
  sumProcessTreeCpuTicks,
  summarizeManagedCpuUsageDeltas,
};
