import getLogger from "@cocalc/backend/logger";
import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import { cpus, loadavg, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { listProjects } from "./sqlite/projects";
import {
  parseBtrfsUsageOutput,
  parseDfOutput,
  readDiskMetrics,
} from "./storage-metrics";
import { getActiveStorageReservationSummary } from "./storage-reservations";

const logger = getLogger("project-host:host-metrics");

const SAMPLE_MS = Math.max(
  5_000,
  Number(process.env.COCALC_PROJECT_HOST_METRICS_SAMPLE_MS ?? 15_000),
);

type CpuSample = {
  ts: number;
  total: number;
  idle: number;
};

type HostMetricsCollector = {
  getCurrentSnapshot: () => HostCurrentMetrics | undefined;
  refresh: () => Promise<HostCurrentMetrics | undefined>;
};

function round1(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.round((value ?? 0) * 10) / 10;
}

function round2(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.round((value ?? 0) * 100) / 100;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function readCpuSample(): CpuSample {
  let total = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return {
    ts: Date.now(),
    total,
    idle,
  };
}

function computeCpuPercent(
  prev: CpuSample | undefined,
  next: CpuSample,
): number | undefined {
  if (!prev) return undefined;
  const elapsedMs = next.ts - prev.ts;
  if (elapsedMs < 1_000) return undefined;
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idle - prev.idle;
  if (!(totalDelta > 0) || idleDelta < 0) return undefined;
  return round1(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)));
}

async function readMeminfo(): Promise<{
  memory_total_bytes?: number;
  memory_available_bytes?: number;
  memory_used_bytes?: number;
  memory_used_percent?: number;
  swap_total_bytes?: number;
  swap_used_bytes?: number;
}> {
  try {
    const raw = await readFile("/proc/meminfo", "utf8");
    const info = new Map<string, number>();
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Za-z_()]+):\s+([0-9]+)\s+kB$/u.exec(line.trim());
      if (!match) continue;
      info.set(match[1], Number(match[2]) * 1024);
    }
    const memory_total_bytes =
      info.get("MemTotal") ?? parseNonNegativeNumber(totalmem());
    const memory_available_bytes =
      info.get("MemAvailable") ?? info.get("MemFree");
    const memory_used_bytes =
      memory_total_bytes != null && memory_available_bytes != null
        ? Math.max(0, memory_total_bytes - memory_available_bytes)
        : undefined;
    const memory_used_percent =
      memory_total_bytes && memory_used_bytes != null
        ? round1((memory_used_bytes / memory_total_bytes) * 100)
        : undefined;
    const swap_total_bytes = info.get("SwapTotal");
    const swap_free_bytes = info.get("SwapFree");
    const swap_used_bytes =
      swap_total_bytes != null && swap_free_bytes != null
        ? Math.max(0, swap_total_bytes - swap_free_bytes)
        : undefined;
    return {
      memory_total_bytes,
      memory_available_bytes,
      memory_used_bytes,
      memory_used_percent,
      swap_total_bytes,
      swap_used_bytes,
    };
  } catch (err) {
    logger.debug("failed to read /proc/meminfo", { err: `${err}` });
    const memory_total_bytes = parseNonNegativeNumber(totalmem());
    return {
      memory_total_bytes,
    };
  }
}

function readProjectCounts(): Pick<
  HostCurrentMetrics,
  | "assigned_project_count"
  | "running_project_count"
  | "starting_project_count"
  | "stopping_project_count"
> {
  const rows = listProjects();
  let running = 0;
  let starting = 0;
  let stopping = 0;
  for (const row of rows) {
    if (row.state === "running") running += 1;
    if (row.state === "starting") starting += 1;
    if (row.state === "stopping") stopping += 1;
  }
  return {
    assigned_project_count: rows.length,
    running_project_count: running,
    starting_project_count: starting,
    stopping_project_count: stopping,
  };
}

async function collectSnapshot(
  prevCpuSample: CpuSample | undefined,
): Promise<{ snapshot: HostCurrentMetrics; cpuSample: CpuSample }> {
  const cpuSample = readCpuSample();
  const [memory, disk] = await Promise.all([readMeminfo(), readDiskMetrics()]);
  const projects = readProjectCounts();
  const reservation_bytes = getActiveStorageReservationSummary().total_bytes;
  const disk_available_for_admission_bytes =
    disk.disk_available_conservative_bytes != null
      ? Math.max(0, disk.disk_available_conservative_bytes - reservation_bytes)
      : undefined;
  return {
    cpuSample,
    snapshot: {
      collected_at: new Date(cpuSample.ts).toISOString(),
      cpu_percent: computeCpuPercent(prevCpuSample, cpuSample),
      load_1: round2(loadavg()[0]),
      load_5: round2(loadavg()[1]),
      load_15: round2(loadavg()[2]),
      ...memory,
      ...disk,
      disk_available_for_admission_bytes,
      reservation_bytes,
      ...projects,
    },
  };
}

export function startHostMetricsCollector(): HostMetricsCollector {
  let current: HostCurrentMetrics | undefined;
  let prevCpuSample = readCpuSample();
  let refreshInFlight: Promise<HostCurrentMetrics | undefined> | undefined;

  const refresh = async (): Promise<HostCurrentMetrics | undefined> => {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const { snapshot, cpuSample } = await collectSnapshot(prevCpuSample);
        prevCpuSample = cpuSample;
        current = snapshot;
        return current;
      } catch (err) {
        logger.warn("failed collecting host metrics snapshot", {
          err: `${err}`,
        });
        return current;
      } finally {
        refreshInFlight = undefined;
      }
    })();
    return await refreshInFlight;
  };

  void refresh();
  const timer = setInterval(() => {
    void refresh();
  }, SAMPLE_MS);
  timer.unref?.();

  return {
    getCurrentSnapshot: () => current,
    refresh,
  };
}

export const _test = {
  parseBtrfsUsageOutput,
  parseDfOutput,
};
