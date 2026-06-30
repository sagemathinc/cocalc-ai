import getLogger from "@cocalc/backend/logger";
import { podman } from "@cocalc/backend/podman";
import type {
  HostResourcePressureMetrics,
  HostResourcePressureProjectSummary,
} from "@cocalc/conat/hub/api/hosts";
import { readdir, readFile, readlink } from "node:fs/promises";

const logger = getLogger("project-host:resource-pressure");

type PodmanLike = (
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ stdout?: string; stderr?: string; exit_code?: number }>;

type ProjectContainer = {
  id: string;
  name: string;
  project_id: string;
};

type ProjectContainerWithPid = ProjectContainer & {
  root_pid: number;
};

type ScanContext = {
  deadline_ms: number;
  max_fd_entries: number;
  fd_entries_scanned: number;
  truncated: boolean;
};

type ProjectResourcePressureSample = {
  project_id: string;
  container_id: string;
  container_name: string;
  root_pid: number;
  sampled_at_ms: number;
  scan_duration_ms: number;
  pids: number;
  threads: number;
  file_descriptors: number;
  sockets: number;
  inotify_instances: number;
  inotify_watches: number;
  truncated?: boolean;
  error?: string;
};

export type ResourcePressureLastScanSummary = {
  duration_ms: number;
  project_count: number;
  truncated: boolean;
  error_count: number;
};

type RefreshOptions = {
  now?: number;
  podmanCommand?: PodmanLike;
};

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_SCAN_BUDGET_MS = 750;
const DEFAULT_MIN_RESCAN_MS = 60_000;
const DEFAULT_FRESH_SAMPLE_MS = 5 * 60_000;
const DEFAULT_MAX_FD_ENTRIES_PER_TICK = 200_000;

const BATCH_SIZE = positiveIntegerEnv(
  "COCALC_PROJECT_HOST_RESOURCE_PRESSURE_BATCH_SIZE",
  DEFAULT_BATCH_SIZE,
);
const SCAN_BUDGET_MS = positiveIntegerEnv(
  "COCALC_PROJECT_HOST_RESOURCE_PRESSURE_SCAN_BUDGET_MS",
  DEFAULT_SCAN_BUDGET_MS,
);
const MIN_RESCAN_MS = positiveIntegerEnv(
  "COCALC_PROJECT_HOST_RESOURCE_PRESSURE_MIN_RESCAN_MS",
  DEFAULT_MIN_RESCAN_MS,
);
const FRESH_SAMPLE_MS = positiveIntegerEnv(
  "COCALC_PROJECT_HOST_RESOURCE_PRESSURE_FRESH_SAMPLE_MS",
  DEFAULT_FRESH_SAMPLE_MS,
);
const MAX_FD_ENTRIES_PER_TICK = positiveIntegerEnv(
  "COCALC_PROJECT_HOST_RESOURCE_PRESSURE_MAX_FD_ENTRIES_PER_TICK",
  DEFAULT_MAX_FD_ENTRIES_PER_TICK,
);

const samples = new Map<string, ProjectResourcePressureSample>();
let cursor = 0;
let lastScan: ResourcePressureLastScanSummary | undefined;
let refreshInFlight:
  | Promise<HostResourcePressureMetrics | undefined>
  | undefined;

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = `${process.env[name] ?? ""}`.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

function normalizeContainerName(name: unknown): string | undefined {
  const value = `${name ?? ""}`.trim().replace(/^\/+/, "");
  return value || undefined;
}

function projectIdFromContainerName(
  name: string | undefined,
): string | undefined {
  return name?.match(/^project-([0-9a-fA-F-]{36})$/)?.[1];
}

async function listRunningProjectContainers(
  podmanCommand: PodmanLike,
): Promise<ProjectContainer[]> {
  const ps = await podmanCommand(
    ["ps", "--filter", "label=role=project", "--format", "json"],
    { timeout: 10 },
  );
  const parsed = `${ps.stdout ?? ""}`.trim()
    ? JSON.parse(`${ps.stdout ?? ""}`)
    : [];
  const out: ProjectContainer[] = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const id = `${row?.Id ?? row?.ID ?? ""}`.trim();
    const names = Array.isArray(row?.Names)
      ? row.Names
      : [row?.Names ?? row?.Name ?? row?.Names0];
    const name = normalizeContainerName(names.find(Boolean));
    const project_id = projectIdFromContainerName(name);
    if (!id || !name || !project_id) continue;
    out.push({ id, name, project_id });
  }
  out.sort((a, b) => a.project_id.localeCompare(b.project_id));
  return out;
}

async function inspectProjectContainerPids(
  containers: ProjectContainer[],
  podmanCommand: PodmanLike,
): Promise<ProjectContainerWithPid[]> {
  if (containers.length === 0) return [];
  const inspect = await podmanCommand(
    [
      "inspect",
      ...containers.map((container) => container.id),
      "--format",
      "json",
    ],
    { timeout: 10 },
  );
  const parsed = `${inspect.stdout ?? ""}`.trim()
    ? JSON.parse(`${inspect.stdout ?? ""}`)
    : [];
  const byName = new Map(
    containers.map((container) => [container.name, container]),
  );
  const out: ProjectContainerWithPid[] = [];
  for (const row of Array.isArray(parsed) ? parsed : []) {
    const name = normalizeContainerName(row?.Name);
    const container = name ? byName.get(name) : undefined;
    const root_pid = Number(row?.State?.Pid);
    if (!container || !Number.isInteger(root_pid) || root_pid <= 1) continue;
    out.push({ ...container, root_pid });
  }
  return out;
}

async function readChildPids(pid: number): Promise<number[]> {
  try {
    const raw = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
    return raw
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 1);
  } catch {
    return [];
  }
}

async function processTreePids(
  rootPid: number,
  context: ScanContext,
): Promise<number[]> {
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    if (budgetExceeded(context)) break;
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    for (const child of await readChildPids(pid)) {
      stack.push(child);
    }
  }
  return out;
}

function budgetExceeded(context: ScanContext): boolean {
  if (Date.now() >= context.deadline_ms) {
    context.truncated = true;
    return true;
  }
  if (context.fd_entries_scanned >= context.max_fd_entries) {
    context.truncated = true;
    return true;
  }
  return false;
}

async function readThreadCount(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const raw = status.match(/(?:^|\n)Threads:\s+(\d+)/)?.[1];
    const threads = Number(raw);
    return Number.isInteger(threads) && threads > 0 ? threads : 1;
  } catch {
    return 1;
  }
}

function countInotifyWatches(fdinfo: string): number {
  return fdinfo.split(/\r?\n/).filter((line) => line.startsWith("inotify wd:"))
    .length;
}

async function scanProjectContainer(
  container: ProjectContainerWithPid,
  context: ScanContext,
  now: number,
): Promise<ProjectResourcePressureSample> {
  const start = Date.now();
  let pids = 0;
  let threads = 0;
  let file_descriptors = 0;
  let sockets = 0;
  let inotify_instances = 0;
  let inotify_watches = 0;
  const treePids = await processTreePids(container.root_pid, context);

  try {
    for (const pid of treePids) {
      if (budgetExceeded(context)) break;
      pids += 1;
      threads += await readThreadCount(pid);
      let fds: string[];
      try {
        fds = await readdir(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      file_descriptors += fds.length;
      for (const fd of fds) {
        if (budgetExceeded(context)) break;
        context.fd_entries_scanned += 1;
        let link = "";
        try {
          link = await readlink(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        if (link.startsWith("socket:")) {
          sockets += 1;
          continue;
        }
        if (link !== "anon_inode:inotify") continue;
        inotify_instances += 1;
        try {
          const fdinfo = await readFile(`/proc/${pid}/fdinfo/${fd}`, "utf8");
          inotify_watches += countInotifyWatches(fdinfo);
        } catch {
          // Process or fd can disappear while scanning.
        }
      }
    }
    return {
      project_id: container.project_id,
      container_id: container.id,
      container_name: container.name,
      root_pid: container.root_pid,
      sampled_at_ms: now,
      scan_duration_ms: Date.now() - start,
      pids,
      threads,
      file_descriptors,
      sockets,
      inotify_instances,
      inotify_watches,
      ...(context.truncated ? { truncated: true } : {}),
    };
  } catch (err) {
    return {
      project_id: container.project_id,
      container_id: container.id,
      container_name: container.name,
      root_pid: container.root_pid,
      sampled_at_ms: now,
      scan_duration_ms: Date.now() - start,
      pids,
      threads,
      file_descriptors,
      sockets,
      inotify_instances,
      inotify_watches,
      truncated: true,
      error: `${err}`,
    };
  }
}

function selectContainersToScan(
  containers: ProjectContainer[],
  now: number,
): ProjectContainer[] {
  if (containers.length === 0) {
    cursor = 0;
    return [];
  }
  if (cursor >= containers.length) cursor = 0;
  const selected: ProjectContainer[] = [];
  for (let offset = 0; offset < containers.length; offset += 1) {
    const index = (cursor + offset) % containers.length;
    const container = containers[index];
    const sample = samples.get(container.project_id);
    if (!sample || now - sample.sampled_at_ms >= MIN_RESCAN_MS) {
      selected.push(container);
    }
    if (selected.length >= BATCH_SIZE) {
      cursor = (index + 1) % containers.length;
      break;
    }
    if (offset === containers.length - 1) {
      cursor = (index + 1) % containers.length;
    }
  }
  return selected;
}

function toProjectSummary(
  sample: ProjectResourcePressureSample,
  now: number,
): HostResourcePressureProjectSummary {
  return {
    project_id: sample.project_id,
    sampled_at_ms: sample.sampled_at_ms,
    age_ms: Math.max(0, now - sample.sampled_at_ms),
    pids: sample.pids,
    threads: sample.threads,
    file_descriptors: sample.file_descriptors,
    sockets: sample.sockets,
    inotify_instances: sample.inotify_instances,
    inotify_watches: sample.inotify_watches,
    ...(sample.truncated ? { truncated: true } : {}),
    ...(sample.error ? { error: sample.error } : {}),
  };
}

function maxBy(
  summaries: HostResourcePressureProjectSummary[],
  key: keyof Pick<
    HostResourcePressureProjectSummary,
    "file_descriptors" | "sockets" | "inotify_instances" | "inotify_watches"
  >,
): HostResourcePressureProjectSummary | undefined {
  let best: HostResourcePressureProjectSummary | undefined;
  for (const summary of summaries) {
    if (!best || summary[key] > best[key]) best = summary;
  }
  return best && best[key] > 0 ? best : undefined;
}

export function summarizeResourcePressure({
  running_project_ids,
  now,
  last_scan,
}: {
  running_project_ids: string[];
  now: number;
  last_scan?: ResourcePressureLastScanSummary;
}): HostResourcePressureMetrics {
  const running = new Set(running_project_ids);
  for (const project_id of [...samples.keys()]) {
    if (!running.has(project_id)) {
      samples.delete(project_id);
    }
  }

  const summaries = [...samples.values()]
    .filter((sample) => running.has(sample.project_id))
    .map((sample) => toProjectSummary(sample, now));
  const sampledIds = new Set(summaries.map((sample) => sample.project_id));
  const missing_project_count = running_project_ids.filter(
    (project_id) => !sampledIds.has(project_id),
  ).length;

  let fresh_project_count = 0;
  let stale_project_count = 0;
  let truncated_project_count = 0;
  let error_project_count = 0;
  let total_pids = 0;
  let total_threads = 0;
  let total_file_descriptors = 0;
  let total_sockets = 0;
  let total_inotify_instances = 0;
  let total_inotify_watches = 0;
  for (const summary of summaries) {
    if (summary.age_ms <= FRESH_SAMPLE_MS) {
      fresh_project_count += 1;
    } else {
      stale_project_count += 1;
    }
    if (summary.truncated) truncated_project_count += 1;
    if (summary.error) error_project_count += 1;
    total_pids += summary.pids;
    total_threads += summary.threads;
    total_file_descriptors += summary.file_descriptors;
    total_sockets += summary.sockets;
    total_inotify_instances += summary.inotify_instances;
    total_inotify_watches += summary.inotify_watches;
  }

  return {
    collected_at: new Date(now).toISOString(),
    running_project_count: running_project_ids.length,
    sampled_project_count: summaries.length,
    fresh_project_count,
    stale_project_count,
    missing_project_count,
    truncated_project_count,
    error_project_count,
    total_pids,
    total_threads,
    total_file_descriptors,
    total_sockets,
    total_inotify_instances,
    total_inotify_watches,
    ...(last_scan
      ? {
          last_scan_duration_ms: last_scan.duration_ms,
          last_scan_project_count: last_scan.project_count,
          last_scan_truncated: last_scan.truncated,
          last_scan_error_count: last_scan.error_count,
        }
      : {}),
    ...(maxBy(summaries, "file_descriptors")
      ? { largest_file_descriptors: maxBy(summaries, "file_descriptors") }
      : {}),
    ...(maxBy(summaries, "sockets")
      ? { largest_sockets: maxBy(summaries, "sockets") }
      : {}),
    ...(maxBy(summaries, "inotify_instances")
      ? { largest_inotify_instances: maxBy(summaries, "inotify_instances") }
      : {}),
    ...(maxBy(summaries, "inotify_watches")
      ? { largest_inotify_watches: maxBy(summaries, "inotify_watches") }
      : {}),
  };
}

export async function refreshResourcePressureMetrics(
  opts: RefreshOptions = {},
): Promise<HostResourcePressureMetrics | undefined> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const now = opts.now ?? Date.now();
    const started = Date.now();
    const podmanCommand = opts.podmanCommand ?? podman;
    try {
      const containers = await listRunningProjectContainers(podmanCommand);
      const selected = selectContainersToScan(containers, now);
      const context: ScanContext = {
        deadline_ms: Date.now() + SCAN_BUDGET_MS,
        max_fd_entries: MAX_FD_ENTRIES_PER_TICK,
        fd_entries_scanned: 0,
        truncated: false,
      };
      let error_count = 0;
      if (selected.length > 0) {
        try {
          const inspected = await inspectProjectContainerPids(
            selected,
            podmanCommand,
          );
          for (const container of inspected) {
            if (budgetExceeded(context)) break;
            const sample = await scanProjectContainer(container, context, now);
            if (sample.error) error_count += 1;
            samples.set(container.project_id, sample);
          }
          error_count += Math.max(0, selected.length - inspected.length);
        } catch (err) {
          error_count += selected.length;
          logger.debug("resource pressure selected-container scan failed", {
            err: `${err}`,
            selected_count: selected.length,
          });
        }
      }
      lastScan = {
        duration_ms: Date.now() - started,
        project_count: selected.length,
        truncated: context.truncated,
        error_count,
      };
      return summarizeResourcePressure({
        running_project_ids: containers.map(
          (container) => container.project_id,
        ),
        now,
        last_scan: lastScan,
      });
    } catch (err) {
      logger.debug("resource pressure refresh failed", { err: `${err}` });
      const cachedProjectIds = [...samples.keys()];
      lastScan = {
        duration_ms: Date.now() - started,
        project_count: 0,
        truncated: true,
        error_count: 1,
      };
      return summarizeResourcePressure({
        running_project_ids: cachedProjectIds,
        now,
        last_scan: lastScan,
      });
    } finally {
      refreshInFlight = undefined;
    }
  })();
  return await refreshInFlight;
}

export const _test = {
  countInotifyWatches,
  maxBy,
  normalizeContainerName,
  projectIdFromContainerName,
  resetSamples: () => samples.clear(),
  setSample: (sample: any) => samples.set(sample.project_id, sample),
  summarizeResourcePressure,
};
