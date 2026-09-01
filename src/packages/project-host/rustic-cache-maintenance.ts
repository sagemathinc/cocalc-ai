import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { lstat, readdir, readFile, rm, statfs } from "node:fs/promises";
import { promisify } from "node:util";

import getLogger from "@cocalc/backend/logger";
import type { HostCurrentMetrics } from "@cocalc/conat/hub/api/hosts";

const logger = getLogger("project-host:rustic-cache-maintenance");
const execFileAsync = promisify(execFile);

const GIB = 1024 ** 3;
const MINUTE_MS = 60 * 1000;
const DEFAULT_MAX_BYTES = 4 * GIB;
const DEFAULT_TARGET_BYTES = 3 * GIB;
const DEFAULT_HARD_MAX_BYTES = 6 * GIB;
const DEFAULT_MIN_ROOT_FREE_BYTES = 5 * GIB;
const DEFAULT_TARGET_ROOT_FREE_BYTES = 6 * GIB;
const DEFAULT_CRITICAL_ROOT_FREE_BYTES = 2 * GIB;
const DEFAULT_MIN_ENTRY_AGE_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_INTERVAL_MS = 10 * MINUTE_MS;

export type RusticCacheMaintenanceStatus =
  | "idle"
  | "measured"
  | "cleaned"
  | "skipped_active"
  | "blocked_recent"
  | "error";

export type RusticCacheEntry = {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
};

export type RusticCacheMaintenanceConfig = {
  enabled: boolean;
  cacheRoot: string;
  maxBytes: number;
  targetBytes: number;
  hardMaxBytes: number;
  minRootFreeBytes: number;
  targetRootFreeBytes: number;
  criticalRootFreeBytes: number;
  minEntryAgeMs: number;
  intervalMs: number;
};

export type RusticCacheSweepDependencies = {
  listEntries: (cacheRoot: string) => Promise<RusticCacheEntry[]>;
  rootAvailableBytes: () => Promise<number | undefined>;
  isRusticActive: () => Promise<boolean>;
  removeEntry: (entry: RusticCacheEntry) => Promise<void>;
  now: () => number;
};

type RusticCacheMaintenanceMetrics = Pick<
  HostCurrentMetrics,
  | "rustic_cache_bytes"
  | "rustic_cache_repository_count"
  | "rustic_cache_limit_bytes"
  | "rustic_cache_target_bytes"
  | "rustic_cache_hard_limit_bytes"
  | "rustic_cache_last_sweep_at"
  | "rustic_cache_last_cleanup_at"
  | "rustic_cache_last_cleanup_freed_bytes"
  | "rustic_cache_maintenance_status"
  | "rustic_cache_maintenance_error"
>;

let metrics: RusticCacheMaintenanceMetrics = {
  rustic_cache_maintenance_status: "idle",
};
let sweepInFlight: Promise<void> | undefined;

function parseBytesFromGib(
  value: string | undefined,
  fallback: number,
): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed * GIB)
    : fallback;
}

function parseMinutes(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed * MINUTE_MS)
    : fallback;
}

function parseEnabled(value: string | undefined): boolean {
  if (value == null || value.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function readRusticCacheMaintenanceConfig(): RusticCacheMaintenanceConfig {
  const maxBytes = parseBytesFromGib(
    process.env.COCALC_RUSTIC_CACHE_MAX_GIB,
    DEFAULT_MAX_BYTES,
  );
  const configuredTargetBytes = parseBytesFromGib(
    process.env.COCALC_RUSTIC_CACHE_TARGET_GIB,
    DEFAULT_TARGET_BYTES,
  );
  const configuredHardMaxBytes = parseBytesFromGib(
    process.env.COCALC_RUSTIC_CACHE_HARD_MAX_GIB,
    DEFAULT_HARD_MAX_BYTES,
  );
  const minRootFreeBytes = parseBytesFromGib(
    process.env.COCALC_RUSTIC_CACHE_MIN_ROOT_FREE_GIB,
    DEFAULT_MIN_ROOT_FREE_BYTES,
  );
  const configuredTargetRootFreeBytes = parseBytesFromGib(
    process.env.COCALC_RUSTIC_CACHE_TARGET_ROOT_FREE_GIB,
    DEFAULT_TARGET_ROOT_FREE_BYTES,
  );
  const cacheRoot = resolve(
    process.env.COCALC_RUSTIC_CACHE_DIR ??
      join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "rustic"),
  );
  if (basename(cacheRoot) !== "rustic") {
    throw new Error(
      `COCALC_RUSTIC_CACHE_DIR must name a rustic directory, got ${cacheRoot}`,
    );
  }
  return {
    enabled: parseEnabled(process.env.COCALC_RUSTIC_CACHE_MAINTENANCE),
    cacheRoot,
    maxBytes,
    targetBytes: Math.min(configuredTargetBytes, maxBytes),
    hardMaxBytes: Math.max(configuredHardMaxBytes, maxBytes),
    minRootFreeBytes,
    targetRootFreeBytes: Math.max(
      configuredTargetRootFreeBytes,
      minRootFreeBytes,
    ),
    criticalRootFreeBytes: Math.min(
      parseBytesFromGib(
        process.env.COCALC_RUSTIC_CACHE_CRITICAL_ROOT_FREE_GIB,
        DEFAULT_CRITICAL_ROOT_FREE_BYTES,
      ),
      minRootFreeBytes,
    ),
    minEntryAgeMs: parseMinutes(
      process.env.COCALC_RUSTIC_CACHE_MIN_ENTRY_AGE_MINUTES,
      DEFAULT_MIN_ENTRY_AGE_MS,
    ),
    intervalMs: Math.max(
      MINUTE_MS,
      parseMinutes(
        process.env.COCALC_RUSTIC_CACHE_MAINTENANCE_INTERVAL_MINUTES,
        DEFAULT_INTERVAL_MS,
      ),
    ),
  };
}

function parseDirectoryUsage(output: string): {
  bytes: number;
  mtimeMs: number;
} {
  const [bytesText, modifiedSecondsText] = output.trim().split(/\s+/u, 3);
  const bytes = Number(bytesText);
  const modifiedSeconds = Number(modifiedSecondsText);
  if (
    !Number.isFinite(bytes) ||
    bytes < 0 ||
    !Number.isFinite(modifiedSeconds) ||
    modifiedSeconds < 0
  ) {
    throw new Error(`invalid du output: ${output.trim()}`);
  }
  return { bytes, mtimeMs: modifiedSeconds * 1000 };
}

async function directoryUsage(path: string): Promise<{
  bytes: number;
  mtimeMs: number;
}> {
  const { stdout } = await execFileAsync(
    "du",
    ["-s", "--block-size=1", "--time", "--time-style=+%s.%N", "--", path],
    {
      maxBuffer: 1024 * 1024,
      timeout: 5 * MINUTE_MS,
    },
  );
  return parseDirectoryUsage(stdout);
}

async function listCacheEntries(
  cacheRoot: string,
): Promise<RusticCacheEntry[]> {
  try {
    const rootInfo = await lstat(cacheRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new Error(
        `Rustic cache root is not a real directory: ${cacheRoot}`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  let children;
  try {
    children = await readdir(cacheRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const entries: RusticCacheEntry[] = [];
  // Measure sequentially so maintenance never creates its own I/O burst.
  for (const child of children) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    const path = join(cacheRoot, child.name);
    // GNU du reports the newest descendant mtime while traversing for size.
    // The repository directory itself is not touched when Rustic updates
    // nested indexes or snapshots, so its own mtime is not a useful LRU key.
    const { bytes, mtimeMs } = await directoryUsage(path);
    entries.push({
      name: child.name,
      path,
      bytes,
      mtimeMs,
    });
  }
  return entries;
}

async function readRootAvailableBytes(): Promise<number | undefined> {
  const info = await statfs("/");
  const value = Number(info.bsize) * Number(info.bavail);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function isRusticProcessActive(): Promise<boolean> {
  let processes;
  try {
    processes = await readdir("/proc", { withFileTypes: true });
  } catch {
    // If activity cannot be established, fail closed and do not evict.
    return true;
  }
  for (const process of processes) {
    if (!process.isDirectory() || !/^\d+$/u.test(process.name)) continue;
    try {
      const comm = (
        await readFile(`/proc/${process.name}/comm`, "utf8")
      ).trim();
      if (comm === "rustic" || comm.startsWith("rustic-")) return true;
    } catch {
      // Processes commonly disappear while /proc is scanned.
    }
  }
  return false;
}

const defaultDependencies: RusticCacheSweepDependencies = {
  listEntries: listCacheEntries,
  rootAvailableBytes: readRootAvailableBytes,
  isRusticActive: isRusticProcessActive,
  removeEntry: async (entry) => {
    await rm(entry.path, { recursive: true, force: true });
  },
  now: Date.now,
};

function updateMeasuredMetrics({
  config,
  totalBytes,
  repositoryCount,
  status,
  error,
}: {
  config: RusticCacheMaintenanceConfig;
  totalBytes: number;
  repositoryCount: number;
  status: RusticCacheMaintenanceStatus;
  error?: string;
}) {
  metrics = {
    ...metrics,
    rustic_cache_bytes: totalBytes,
    rustic_cache_repository_count: repositoryCount,
    rustic_cache_limit_bytes: config.maxBytes,
    rustic_cache_target_bytes: config.targetBytes,
    rustic_cache_hard_limit_bytes: config.hardMaxBytes,
    rustic_cache_last_sweep_at: new Date().toISOString(),
    rustic_cache_maintenance_status: status,
    ...(error
      ? { rustic_cache_maintenance_error: error }
      : { rustic_cache_maintenance_error: undefined }),
  };
}

function recordCleanup(freedBytes: number) {
  if (freedBytes <= 0) return;
  metrics = {
    ...metrics,
    rustic_cache_last_cleanup_at: new Date().toISOString(),
    rustic_cache_last_cleanup_freed_bytes: freedBytes,
  };
}

export async function runRusticCacheSweep(
  config: RusticCacheMaintenanceConfig = readRusticCacheMaintenanceConfig(),
  dependencies: RusticCacheSweepDependencies = defaultDependencies,
): Promise<void> {
  if (!config.enabled) return;
  // Avoid traversing a potentially large cache while Rustic is already doing
  // backup or restore I/O. The prior measurement remains useful in metrics.
  if (await dependencies.isRusticActive()) {
    metrics = {
      ...metrics,
      rustic_cache_limit_bytes: config.maxBytes,
      rustic_cache_target_bytes: config.targetBytes,
      rustic_cache_hard_limit_bytes: config.hardMaxBytes,
      rustic_cache_last_sweep_at: new Date().toISOString(),
      rustic_cache_maintenance_status: "skipped_active",
      rustic_cache_maintenance_error: undefined,
    };
    return;
  }
  const entries = await dependencies.listEntries(config.cacheRoot);
  let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  let rootAvailableBytes = await dependencies.rootAvailableBytes();
  updateMeasuredMetrics({
    config,
    totalBytes,
    repositoryCount: entries.length,
    status: "measured",
  });

  const cacheBytesToFree =
    totalBytes > config.maxBytes ? totalBytes - config.targetBytes : 0;
  const rootBytesToFree =
    rootAvailableBytes != null && rootAvailableBytes < config.minRootFreeBytes
      ? config.targetRootFreeBytes - rootAvailableBytes
      : 0;
  const bytesToFree = Math.max(cacheBytesToFree, rootBytesToFree);
  if (bytesToFree <= 0 || entries.length === 0) return;

  const now = dependencies.now();
  const warningRootPressure =
    rootAvailableBytes != null && rootAvailableBytes < config.minRootFreeBytes;
  const urgentPressure =
    totalBytes > config.hardMaxBytes ||
    (rootAvailableBytes != null &&
      rootAvailableBytes < config.criticalRootFreeBytes);
  // Under root pressure, preserve only the current maintenance interval. A
  // full-day age floor can otherwise leave a busy host paging indefinitely.
  const minimumEntryAgeMs = warningRootPressure
    ? Math.min(config.minEntryAgeMs, config.intervalMs)
    : config.minEntryAgeMs;
  let freedBytes = 0;
  let repositoryCount = entries.length;
  for (const entry of [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (!urgentPressure && now - entry.mtimeMs < minimumEntryAgeMs) {
      continue;
    }
    // Recheck immediately before each destructive operation. This deliberately
    // favors delaying maintenance over disrupting a backup or restore.
    if (await dependencies.isRusticActive()) {
      updateMeasuredMetrics({
        config,
        totalBytes,
        repositoryCount,
        status: "skipped_active",
      });
      recordCleanup(freedBytes);
      return;
    }
    await dependencies.removeEntry(entry);
    freedBytes += entry.bytes;
    totalBytes = Math.max(0, totalBytes - entry.bytes);
    repositoryCount -= 1;
    if (rootAvailableBytes != null) {
      rootAvailableBytes += entry.bytes;
    }
    updateMeasuredMetrics({
      config,
      totalBytes,
      repositoryCount,
      status: "cleaned",
    });
    recordCleanup(freedBytes);
    if (freedBytes >= bytesToFree) break;
  }

  const status: RusticCacheMaintenanceStatus =
    freedBytes > 0 ? "cleaned" : "blocked_recent";
  updateMeasuredMetrics({
    config,
    totalBytes,
    repositoryCount,
    status,
  });
  if (freedBytes > 0) {
    recordCleanup(freedBytes);
    logger.info("cleaned Rustic cache", {
      cache_root: config.cacheRoot,
      freed_bytes: freedBytes,
      remaining_bytes: totalBytes,
      remaining_repositories: repositoryCount,
    });
  }
}

async function runManagedSweep(
  config: RusticCacheMaintenanceConfig,
): Promise<void> {
  if (sweepInFlight) return await sweepInFlight;
  sweepInFlight = (async () => {
    try {
      await runRusticCacheSweep(config);
    } catch (err) {
      const error = `${err}`;
      metrics = {
        ...metrics,
        rustic_cache_limit_bytes: config.maxBytes,
        rustic_cache_target_bytes: config.targetBytes,
        rustic_cache_hard_limit_bytes: config.hardMaxBytes,
        rustic_cache_last_sweep_at: new Date().toISOString(),
        rustic_cache_maintenance_status: "error",
        rustic_cache_maintenance_error: error,
      };
      logger.warn("Rustic cache maintenance failed", {
        cache_root: config.cacheRoot,
        err: error,
      });
    } finally {
      sweepInFlight = undefined;
    }
  })();
  return await sweepInFlight;
}

export function startRusticCacheMaintenance(): () => void {
  const config = readRusticCacheMaintenanceConfig();
  metrics = {
    rustic_cache_limit_bytes: config.maxBytes,
    rustic_cache_target_bytes: config.targetBytes,
    rustic_cache_hard_limit_bytes: config.hardMaxBytes,
    rustic_cache_maintenance_status: "idle",
  };
  if (!config.enabled) {
    logger.info("Rustic cache maintenance disabled");
    return () => {};
  }
  void runManagedSweep(config);
  const timer = setInterval(() => {
    void runManagedSweep(config);
  }, config.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function getRusticCacheMaintenanceMetrics(): RusticCacheMaintenanceMetrics {
  return { ...metrics };
}

export const _test = {
  defaultDependencies,
  parseBytesFromGib,
  parseDirectoryUsage,
  parseMinutes,
};
