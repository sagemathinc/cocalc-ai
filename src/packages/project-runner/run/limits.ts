/**
 * Assumes cgroup v2 (Ubuntu 25.04 default) and rootless-compatible flags.
 **/
import { k8sCpuParser } from "@cocalc/util/misc";
import { type Configuration } from "@cocalc/conat/project/runner/types";
import { FAIR_CPU_MODE } from "@cocalc/util/upgrade-spec";
import { getContainerSwapSizeMb } from "@cocalc/backend/podman/memory";

const DEFAULT_MEMORY_RESERVATION_RATIO = 0.8;
const DEFAULT_MEMORY_HIGH_RATIO = 0.9;
const MIN_MEMORY_PRESSURE_GAP_RATIO = 0.05;

function parseMemoryRatio(
  name: string,
  defaultValue: number,
  { maxExclusive }: { maxExclusive?: number } = {},
): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return defaultValue;
  }
  const value = Number(raw);
  if (!isFinite(value) || value <= 0) {
    return defaultValue;
  }
  if (maxExclusive != null && value >= maxExclusive) {
    return defaultValue;
  }
  return value;
}

function getMemoryPressureRatios(): {
  reservationRatio: number;
  highRatio: number;
} {
  const highRatio = parseMemoryRatio(
    "COCALC_PROJECT_MEMORY_HIGH_RATIO",
    DEFAULT_MEMORY_HIGH_RATIO,
    { maxExclusive: 1 },
  );
  const defaultReservationRatio = Math.min(
    DEFAULT_MEMORY_RESERVATION_RATIO,
    Math.max(0.01, highRatio - MIN_MEMORY_PRESSURE_GAP_RATIO),
  );
  const reservationRatio = parseMemoryRatio(
    "COCALC_PROJECT_MEMORY_RESERVATION_RATIO",
    defaultReservationRatio,
    { maxExclusive: highRatio },
  );
  return { reservationRatio, highRatio };
}

function limitFromRatio(total: number, ratio: number): number | undefined {
  const value = Math.floor(total * ratio);
  if (!isFinite(value) || value <= 0 || value >= total) {
    return undefined;
  }
  return value;
}

function parseIntegerLimit(name: string, value: unknown, min: number): number {
  const parsed = parseInt(`${value}`, 10);
  if (!isFinite(parsed) || parsed < min) {
    throw Error(`invalid ${name} limit: '${parsed}'`);
  }
  return parsed;
}

export async function podmanLimits(config?: Configuration): Promise<string[]> {
  const args: string[] = [];

  if (!config) {
    return args;
  }

  // CPU
  if (FAIR_CPU_MODE) {
    // When the CPUs are busy they’ll split fairly; when they’re not, any container
    // can burst to 100% with no cap.
    args.push("--cpu-shares=1024");
  } else if (config.cpu != null) {
    const cpu = k8sCpuParser(config.cpu); // accepts "500m", "2", etc.
    if (!isFinite(cpu) || cpu <= 0) {
      throw Error(`invalid cpu limit: '${cpu}'`);
    }
    args.push(`--cpus=${cpu}`);
  }

  // Memory & swap
  if (config.memory != null) {
    args.push(`--memory=${config.memory}`);
    const { reservationRatio, highRatio } = getMemoryPressureRatios();
    const memoryReservation = limitFromRatio(config.memory, reservationRatio);
    const memoryHigh = limitFromRatio(config.memory, highRatio);
    if (memoryReservation != null) {
      args.push(`--memory-reservation=${memoryReservation}`);
    }
    if (memoryHigh != null) {
      args.push(`--cgroup-conf=memory.high=${memoryHigh}`);
    }

    if (config.swap) {
      const swap = await getContainerSwapSizeMb(config.memory);
      if (swap > 0) {
        // its the SUM:
        args.push(`--memory-swap=${config.memory + swap}`);
      }
    }
  }

  // PIDs
  if (config.pids != null) {
    const pids = parseIntegerLimit("pids", config.pids, 1);

    // Total processes in the container:
    args.push(`--pids-limit=${pids}`);
  }

  if (config.nofile != null) {
    const nofile = parseIntegerLimit("nofile", config.nofile, 1);
    args.push(`--ulimit=nofile=${nofile}:${nofile}`);
  }

  if (config.core != null) {
    const core = parseIntegerLimit("core", config.core, 0);
    args.push(`--ulimit=core=${core}:${core}`);
  }

  if (config.shmSize != null) {
    const shmSize = `${config.shmSize}`.trim();
    if (!shmSize) {
      throw Error("invalid shmSize limit: ''");
    }
    args.push(`--shm-size=${shmSize}`);
  }

  return args;
}
