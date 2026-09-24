import getLogger from "@cocalc/backend/logger";
import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";
import { cpus, loadavg, totalmem } from "node:os";
import { readFile, statfs } from "node:fs/promises";
import { getProjectStateCounts } from "./sqlite/projects";
import {
  computeDiskAdmissionAvailableBytes,
  parseBtrfsUsageOutput,
  parseDfOutput,
  readDiskMetrics,
  readSharedScratchMetrics,
} from "./storage-metrics";
import { getActiveStorageReservationSummary } from "./storage-reservations";
import { readProjectHostKernelSysctls } from "./host-sysctl";
import { refreshResourcePressureMetrics } from "./resource-pressure";
import { readIoContainmentMetrics } from "./io-metrics";
import { readConatPersistMetrics } from "./conat-persist-metrics";
import { getStorageAdmissionStatus } from "./storage-admission";
import { getRusticCacheMaintenanceMetrics } from "./rustic-cache-maintenance";
import { getSnapshotBackupMaintenanceGate } from "./snapshot-backup-gate";

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
  const counts = getProjectStateCounts();
  return {
    assigned_project_count: counts.total,
    running_project_count: counts.by_state.running ?? 0,
    starting_project_count: counts.by_state.starting ?? 0,
    stopping_project_count: counts.by_state.stopping ?? 0,
  };
}

type RootFilesystemStat = {
  bsize: number | bigint;
  blocks: number | bigint;
  bfree: number | bigint;
  bavail: number | bigint;
};

export function rootFilesystemMetricsFromStatfs(
  stats: RootFilesystemStat,
): Pick<
  HostCurrentMetrics,
  | "root_disk_total_bytes"
  | "root_disk_used_bytes"
  | "root_disk_available_bytes"
  | "root_disk_used_percent"
> {
  const blockSize = Number(stats.bsize);
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bfree);
  const availableBlocks = Number(stats.bavail);
  if (
    ![blockSize, blocks, freeBlocks, availableBlocks].every(
      (value) => Number.isFinite(value) && value >= 0,
    ) ||
    blockSize <= 0 ||
    blocks <= 0 ||
    freeBlocks > blocks
  ) {
    return {};
  }
  const root_disk_total_bytes = blockSize * blocks;
  const root_disk_used_bytes = blockSize * (blocks - freeBlocks);
  const root_disk_available_bytes = blockSize * availableBlocks;
  const usableBytes = root_disk_used_bytes + root_disk_available_bytes;
  return {
    root_disk_total_bytes,
    root_disk_used_bytes,
    root_disk_available_bytes,
    root_disk_used_percent:
      usableBytes > 0
        ? round1((root_disk_used_bytes / usableBytes) * 100)
        : undefined,
  };
}

async function readRootFilesystemMetrics(): Promise<
  Partial<HostCurrentMetrics>
> {
  try {
    return rootFilesystemMetricsFromStatfs(await statfs("/"));
  } catch (err) {
    logger.debug("failed to read root filesystem metrics", { err: `${err}` });
    return {};
  }
}

async function collectSnapshot(
  prevCpuSample: CpuSample | undefined,
): Promise<{ snapshot: HostCurrentMetrics; cpuSample: CpuSample }> {
  const cpuSample = readCpuSample();
  const [
    memory,
    rootFilesystem,
    disk,
    sharedScratch,
    kernel_sysctls,
    resource_pressure,
    io_containment,
    conat_persist,
  ] = await Promise.all([
    readMeminfo(),
    readRootFilesystemMetrics(),
    readDiskMetrics(),
    readSharedScratchMetrics(),
    readProjectHostKernelSysctls(),
    refreshResourcePressureMetrics(),
    readIoContainmentMetrics(),
    readConatPersistMetrics(),
  ]);
  const projects = readProjectCounts();
  const reservation_bytes = getActiveStorageReservationSummary().total_bytes;
  const disk_available_for_admission_bytes = computeDiskAdmissionAvailableBytes(
    disk,
    reservation_bytes,
  );
  const storageAdmission = getStorageAdmissionStatus();
  return {
    cpuSample,
    snapshot: {
      collected_at: new Date(cpuSample.ts).toISOString(),
      cpu_percent: computeCpuPercent(prevCpuSample, cpuSample),
      load_1: round2(loadavg()[0]),
      load_5: round2(loadavg()[1]),
      load_15: round2(loadavg()[2]),
      ...memory,
      ...rootFilesystem,
      ...getRusticCacheMaintenanceMetrics(),
      ...disk,
      ...sharedScratch,
      disk_available_for_admission_bytes,
      reservation_bytes,
      ...projects,
      kernel_sysctls,
      ...(resource_pressure ? { resource_pressure } : {}),
      io_containment,
      ...(storageAdmission ? { storage_admission: storageAdmission } : {}),
      snapshot_backup_maintenance_gate: getSnapshotBackupMaintenanceGate(),
      ...(conat_persist ? { conat_persist } : {}),
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
  computeDiskAdmissionAvailableBytes,
  parseBtrfsUsageOutput,
  parseDfOutput,
  rootFilesystemMetricsFromStatfs,
};
