/**
 * Assumes cgroup v2 (Ubuntu 25.04 default) and rootless-compatible flags.
 **/
import { k8sCpuParser } from "@cocalc/util/misc";
import { type Configuration } from "@cocalc/conat/project/runner/types";
import { FAIR_CPU_MODE } from "@cocalc/util/upgrade-spec";
import { getContainerSwapSizeMb } from "@cocalc/backend/podman/memory";

const DEFAULT_MEMORY_RESERVATION_RATIO = 0.8;
// memory.high forces synchronous reclaim in the allocating process. For
// interactive projects that can look like a frozen kernel for tens of seconds
// before memory.max is reached, so leave it disabled unless explicitly tuned.
const DEFAULT_MEMORY_HIGH_RATIO = 1;
const MIN_MEMORY_PRESSURE_GAP_RATIO = 0.05;
const CGROUP_CPU_PERIOD_US = 100_000;
const DEFAULT_CPU_SHARES = 1024;
const MAX_CPU_SHARES = 262_144;
const MAX_CPU_PRIORITY = 8;
const DEFAULT_PROJECT_IO_WEIGHT = 100;

export interface ProjectCgroupLimits {
  memory_max: string;
  memory_high: string;
  memory_low: string;
  memory_swap_max: string;
  pids_max: string;
  cpu_max_quota: string;
  cpu_max_period: string;
  cpu_weight: string;
  io_weight: string;
  io_class: "standard" | "member" | "premium";
}

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

export function cpuSharesFromPriority(priority: unknown): number {
  const parsed = Number(priority);
  const normalized =
    Number.isFinite(parsed) && parsed > 0
      ? Math.min(MAX_CPU_PRIORITY, Math.floor(parsed))
      : 0;
  return Math.min(MAX_CPU_SHARES, DEFAULT_CPU_SHARES * Math.pow(2, normalized));
}

export async function podmanLimits(config?: Configuration): Promise<string[]> {
  const args: string[] = [];

  if (!config) {
    return args;
  }

  // CPU
  if (FAIR_CPU_MODE) {
    // CPU remains work-conserving: deliberately ignore config.cpu (the legacy
    // CoCalc.com hard-core limit), leave cpu.max unlimited, and use membership
    // priority for proportional service when sibling cgroups are contending.
    args.push(`--cpu-shares=${cpuSharesFromPriority(config.cpu_priority)}`);
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

function argumentValue(args: string[], prefix: string): string | undefined {
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function integerArgument(args: string[], prefix: string): number | undefined {
  const value = Number(argumentValue(args, prefix));
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function cpuSharesToWeight(shares: number): number {
  const normalized = Math.max(2, Math.min(262_144, Math.floor(shares)));
  return 1 + Math.floor(((normalized - 2) * 9_999) / 262_142);
}

export function projectCgroupLimitsFromPodmanArgs(
  args: string[],
  ioClass?: Configuration["io_class"],
): ProjectCgroupLimits {
  const memoryMax = integerArgument(args, "--memory=");
  const memoryHigh = integerArgument(args, "--cgroup-conf=memory.high=");
  const memoryLow = integerArgument(args, "--memory-reservation=");
  const memorySwapTotal = integerArgument(args, "--memory-swap=");
  const pidsMax = integerArgument(args, "--pids-limit=");
  const cpus = Number(argumentValue(args, "--cpus="));
  const cpuShares = Number(argumentValue(args, "--cpu-shares="));
  const cpuQuota =
    Number.isFinite(cpus) && cpus > 0
      ? Math.max(1, Math.round(cpus * CGROUP_CPU_PERIOD_US))
      : undefined;
  const cpuWeight =
    Number.isFinite(cpuShares) && cpuShares > 0
      ? cpuSharesToWeight(cpuShares)
      : 100;

  return {
    memory_max: memoryMax != null ? `${memoryMax}` : "max",
    memory_high: memoryHigh != null ? `${memoryHigh}` : "max",
    memory_low: memoryLow != null ? `${memoryLow}` : "0",
    // No swap allowance (no --memory-swap, or no --memory at all) means no
    // swap: "max" would let the project use all host swap and thrash other
    // projects once a host has swap or zswap.
    memory_swap_max:
      memoryMax != null && memorySwapTotal != null
        ? `${Math.max(0, memorySwapTotal - memoryMax)}`
        : "0",
    pids_max: pidsMax != null ? `${pidsMax}` : "max",
    cpu_max_quota: cpuQuota != null ? `${cpuQuota}` : "max",
    cpu_max_period: `${CGROUP_CPU_PERIOD_US}`,
    cpu_weight: `${cpuWeight}`,
    io_weight: `${DEFAULT_PROJECT_IO_WEIGHT}`,
    io_class:
      ioClass === "member" || ioClass === "premium" ? ioClass : "standard",
  };
}

const CGROUP_LIMIT_PREFIXES = [
  "--cpu-shares=",
  "--cpus=",
  "--memory=",
  "--memory-reservation=",
  "--memory-swap=",
  "--cgroup-conf=",
  "--pids-limit=",
];

/** Keep limits that do not require Podman to create a cgroup. */
export function withoutPodmanCgroupLimits(args: string[]): string[] {
  return args.filter(
    (arg) => !CGROUP_LIMIT_PREFIXES.some((prefix) => arg.startsWith(prefix)),
  );
}
