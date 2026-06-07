/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { posix } from "node:path";
import { statfs } from "node:fs/promises";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import { fsClient, fsSubject, type ExecOutput } from "@cocalc/conat/files/fs";
import type {
  ProjectDiskQuota,
  ProjectStorageBreakdown,
  ProjectStorageHistory,
  ProjectStorageHistoryGrowth,
  ProjectStorageHistoryPoint,
  ProjectStorageOverview,
  ProjectStorageOverviewRefresh,
  ProjectStorageRetainedSummary,
  ProjectStorageSharedScratchSummary,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/project/storage-info";
import { dstream, type DStream } from "@cocalc/conat/sync/dstream";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import { fileServerClient, getSharedScratchMountpoint } from "./file-server";

const logger = getLogger("project-host:storage-info");

export const PROJECT_STORAGE_INFO_SUBJECT = "project.*.storage-info.-";
export const PROJECT_STORAGE_HISTORY_STREAM_NAME = "project-storage-history";

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

const PROJECT_STORAGE_CACHE_TTL_MS = 3 * 60_000;
const PROJECT_STORAGE_STALE_CACHE_TTL_MS = 24 * 60 * 60_000;
const PROJECT_STORAGE_BREAKDOWN_WAIT_MS = positiveIntegerEnv(
  "COCALC_PROJECT_STORAGE_BREAKDOWN_WAIT_MS",
  10_000,
);
const PROJECT_STORAGE_BREAKDOWN_SCAN_TIMEOUT_MS = positiveIntegerEnv(
  "COCALC_PROJECT_STORAGE_BREAKDOWN_SCAN_TIMEOUT_MS",
  120_000,
);
const PROJECT_STORAGE_SCAN_BUDGET_WINDOW_MS = 60 * 60_000;
const PROJECT_STORAGE_SCAN_BUDGET_MS = 5 * 60_000;
const PROJECT_STORAGE_MIN_SCAN_BUDGET_MS = 1_000;
const PROJECT_STORAGE_FORCE_SAMPLE_MIN_INTERVAL_MS = 60_000;
const STORAGE_HISTORY_SAMPLE_INTERVAL_MS = 5 * 60_000;
const STORAGE_HISTORY_TTL_MS = 35 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MINUTES = 24 * 60;
const DEFAULT_MAX_POINTS = 96;

const projectStorageOverviewCache = new TTL<string, ProjectStorageOverview>({
  ttl: PROJECT_STORAGE_CACHE_TTL_MS,
});
const projectStorageBreakdownCache = new TTL<string, ProjectStorageBreakdown>({
  ttl: PROJECT_STORAGE_CACHE_TTL_MS,
});
const projectStorageBreakdownStaleCache = new TTL<
  string,
  ProjectStorageBreakdown
>({
  ttl: PROJECT_STORAGE_STALE_CACHE_TTL_MS,
});
const projectStorageOverviewInflight = new Map<
  string,
  Promise<ProjectStorageOverview>
>();
const projectStorageBreakdownInflight = new Map<
  string,
  Promise<ProjectStorageBreakdown>
>();
const projectStorageScanBudgets = new TTL<
  string,
  {
    window_start: number;
    used_ms: number;
    reserved_ms: number;
  }
>({
  ttl: 2 * PROJECT_STORAGE_SCAN_BUDGET_WINDOW_MS,
});
const projectStorageForceSampleAt = new Map<string, number>();
const historyStreams = new TTL<string, DStream<ProjectStorageHistoryPoint>>({
  ttl: 30 * 60_000,
  dispose: (stream) => {
    try {
      stream.close();
    } catch {
      // ignore close errors
    }
  },
});
const historyStreamInflight = new Map<
  string,
  Promise<DStream<ProjectStorageHistoryPoint>>
>();

function extractProjectId(subject?: string): string {
  const project_id = extractProjectSubject(`${subject ?? ""}`);
  if (!project_id) {
    throw new Error(`invalid project storage subject '${subject ?? ""}'`);
  }
  return project_id;
}

async function getDiskQuotaImpl({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}): Promise<ProjectDiskQuota> {
  const fileServer = fileServerClient(client);
  return await fileServer.getQuota({ project_id });
}

function normalizeStoragePath(path?: string): string {
  const normalized = posix.normalize(`${path ?? ""}`.trim() || "/");
  if (!normalized.startsWith("/")) {
    throw new Error(`storage path must be absolute: ${path}`);
  }
  return normalized;
}

function storageOverviewCacheKey({
  project_id,
  home,
}: {
  project_id: string;
  home: string;
}): string {
  return `${project_id}:${home}`;
}

function storageBreakdownCacheKey({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): string {
  return `${project_id}:${path}`;
}

function isPathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function rewriteDuOutputPath({
  rowPath,
  requestedPath,
  aliases,
}: {
  rowPath: string;
  requestedPath: string;
  aliases: string[];
}): string {
  for (const alias of aliases) {
    if (!alias || alias === requestedPath) continue;
    if (!isPathWithin(rowPath, alias)) continue;
    if (rowPath === alias) {
      return requestedPath;
    }
    return posix.join(requestedPath, posix.relative(alias, rowPath));
  }
  return rowPath;
}

function parseDuOutput(
  output: ExecOutput,
  path: string,
  aliases: string[] = [],
): ProjectStorageBreakdown {
  const { stdout, stderr, code, truncated } = output;
  const errText = Buffer.from(stderr).toString().trim();
  if (truncated) {
    throw new Error(
      `Disk usage scan for '${path}' took too long on this large folder. Browse into a smaller folder and try again.`,
    );
  }
  const text = Buffer.from(stdout).toString();
  if (!text.trim()) {
    throw new Error(
      errText || `Disk usage scan for '${path}' returned incomplete data.`,
    );
  }
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) {
        throw new Error(
          `Disk usage scan for '${path}' returned invalid data. Try again or browse into a smaller folder.`,
        );
      }
      const rawPath = posix.normalize(match[2]);
      return {
        bytes: Number(match[1]),
        path: rewriteDuOutputPath({
          rowPath: rawPath,
          requestedPath: posix.normalize(path),
          aliases: aliases.map((alias) => posix.normalize(alias)),
        }),
      };
    })
    .filter(
      ({ bytes, path: rowPath }) => Number.isFinite(bytes) && !!rowPath.trim(),
    );
  const requestedPath = posix.normalize(path);
  const root = rows.find(({ path: rowPath }) => rowPath === requestedPath);
  if (!root) {
    throw new Error(
      `Disk usage scan for '${path}' returned incomplete data. Try again or browse into a smaller folder.`,
    );
  }
  if (code && !isIgnorableDuFailure(errText)) {
    throw new Error(errText || `du failed for ${path}`);
  }
  return {
    path: requestedPath,
    bytes: root.bytes,
    children: rows
      .filter(({ path: rowPath }) => rowPath !== requestedPath)
      .map(({ bytes, path: rowPath }) => ({
        bytes,
        path: posix.relative(requestedPath, rowPath),
      })),
    collected_at: new Date().toISOString(),
  };
}

function storageScanBudgetMessage(path: string): string {
  return `Disk usage scan for '${path}' exceeded the quick-scan wait. Showing quota-based or cached usage so storage limits remain visible. A detailed scan may still finish in the background. Browse into a smaller folder for an immediate detailed breakdown.`;
}

function storageScanBudgetExhaustedMessage(): string {
  return `Disk usage scan budget for this project is exhausted. Showing quota-based or cached usage so storage limits remain visible. Try again later or browse into a smaller folder for a cheaper scan.`;
}

function storageScanFailedMessage(path: string): string {
  return `Disk usage scan for '${path}' did not finish within the project scan budget. Showing quota-based or cached usage so storage limits remain visible. Browse into a smaller folder for a detailed breakdown.`;
}

function isStorageScanBudgetError(err: unknown): boolean {
  const message = `${err ?? ""}`.toLowerCase();
  return (
    message.includes("took too long") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function isTimeoutError(err: unknown): boolean {
  return `${err ?? ""}`.toLowerCase().includes("timeout");
}

function withScanFallbackMetadata(
  breakdown: ProjectStorageBreakdown,
  warning: string,
  scan_status: ProjectStorageBreakdown["scan_status"],
): ProjectStorageBreakdown {
  return {
    ...breakdown,
    estimated: true,
    stale: true,
    scan_status,
    warning,
  };
}

function estimatedStorageBreakdown({
  path,
  bytes,
  warning,
  scan_status,
}: {
  path: string;
  bytes: number;
  warning: string;
  scan_status: ProjectStorageBreakdown["scan_status"];
}): ProjectStorageBreakdown {
  return {
    path,
    bytes: Math.max(0, bytes),
    children: [],
    collected_at: new Date().toISOString(),
    estimated: true,
    scan_status,
    warning,
  };
}

function fallbackStorageBreakdown({
  cacheKey,
  normalizedPath,
  fallback_bytes,
  warning,
  scan_status,
}: {
  cacheKey: string;
  normalizedPath: string;
  fallback_bytes?: number;
  warning: string;
  scan_status: ProjectStorageBreakdown["scan_status"];
}): ProjectStorageBreakdown {
  const stale = projectStorageBreakdownStaleCache.get(cacheKey);
  if (stale) {
    return withScanFallbackMetadata(stale, warning, scan_status);
  }
  if (fallback_bytes != null && Number.isFinite(fallback_bytes)) {
    return estimatedStorageBreakdown({
      path: normalizedPath,
      bytes: fallback_bytes,
      warning,
      scan_status,
    });
  }
  throw new Error(warning);
}

function waitForStorageScan<T>({
  promise,
  timeout_ms,
}: {
  promise: Promise<T>;
  timeout_ms: number;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), timeout_ms);
    }),
  ]).finally(() => {
    if (timer != null) {
      clearTimeout(timer);
    }
  });
}

function claimProjectScanBudget(project_id: string):
  | {
      timeout_ms: number;
      finish: () => void;
    }
  | undefined {
  const now = Date.now();
  let budget = projectStorageScanBudgets.get(project_id);
  if (
    !budget ||
    now - budget.window_start >= PROJECT_STORAGE_SCAN_BUDGET_WINDOW_MS
  ) {
    budget = { window_start: now, used_ms: 0, reserved_ms: 0 };
  }
  const remaining =
    PROJECT_STORAGE_SCAN_BUDGET_MS - budget.used_ms - budget.reserved_ms;
  if (remaining < PROJECT_STORAGE_MIN_SCAN_BUDGET_MS) {
    projectStorageScanBudgets.set(project_id, budget);
    return undefined;
  }
  const reserved_ms = Math.min(
    PROJECT_STORAGE_BREAKDOWN_SCAN_TIMEOUT_MS,
    remaining,
  );
  budget.reserved_ms += reserved_ms;
  projectStorageScanBudgets.set(project_id, budget);
  const started = Date.now();
  let finished = false;
  return {
    timeout_ms: reserved_ms,
    finish: () => {
      if (finished) return;
      finished = true;
      const latest = projectStorageScanBudgets.get(project_id) ?? budget!;
      latest.reserved_ms = Math.max(0, latest.reserved_ms - reserved_ms);
      latest.used_ms += Math.min(
        reserved_ms,
        Math.max(0, Date.now() - started),
      );
      projectStorageScanBudgets.set(project_id, latest);
    },
  };
}

function isIgnorableDuFailure(errText: string): boolean {
  const lines = errText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) =>
      /(?:^|\/)du: (?:cannot read directory|cannot access) .+: (?:Permission denied|Operation not permitted)$/.test(
        line,
      ),
    )
  );
}

function buildRetainedSummary({
  quotaUsed,
  liveBytes,
}: {
  quotaUsed?: number;
  liveBytes: number;
}): ProjectStorageRetainedSummary {
  const bytes =
    quotaUsed == null || !Number.isFinite(quotaUsed)
      ? 0
      : Math.max(0, quotaUsed - liveBytes);
  return {
    key: "retained",
    label: "Retained snapshot/history data",
    bytes,
    detail:
      "Estimate computed as project quota used minus current live files. This usually comes from snapshots retaining deleted or modified data, and can decrease automatically as older snapshots expire.",
  };
}

async function getSharedScratchSummary(): Promise<
  ProjectStorageSharedScratchSummary | undefined
> {
  const mount = getSharedScratchMountpoint();
  if (!mount) return undefined;
  const stats = await statfs(mount);
  const size = Math.max(0, stats.blocks * stats.bsize);
  const free = Math.max(0, stats.bfree * stats.bsize);
  return {
    key: "shared_scratch",
    label: "Host shared scratch",
    path: "/scratch",
    used: Math.max(0, size - free),
    size,
    free,
    available: Math.max(0, stats.bavail * stats.bsize),
    collected_at: new Date().toISOString(),
  };
}

function normalizeWindowMinutes(value?: number): number {
  const parsed = Number(value ?? DEFAULT_WINDOW_MINUTES);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.min(30 * 24 * 60, Math.max(60, Math.floor(parsed)));
}

function normalizeMaxPoints(value?: number): number {
  const parsed = Number(value ?? DEFAULT_MAX_POINTS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_POINTS;
  }
  return Math.min(1440, Math.max(24, Math.floor(parsed)));
}

function compactPoints<T>(points: T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) return points;
  const result: T[] = [];
  const lastIndex = points.length - 1;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.round((i * lastIndex) / Math.max(1, maxPoints - 1));
    result.push(points[index]);
  }
  return result;
}

function computePercent(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  if (
    numerator == null ||
    denominator == null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (100 * numerator) / denominator));
}

function computeGrowth(
  points: ProjectStorageHistoryPoint[],
  window_minutes: number,
): ProjectStorageHistoryGrowth | undefined {
  const defined = points.filter(
    (point) =>
      point.quota_used_bytes != null &&
      Number.isFinite(point.quota_used_bytes) &&
      point.collected_at,
  );
  if (defined.length < 2) return undefined;
  const first = defined[0];
  const last = defined[defined.length - 1];
  const firstAt = Date.parse(first.collected_at);
  const lastAt = Date.parse(last.collected_at);
  if (
    !Number.isFinite(firstAt) ||
    !Number.isFinite(lastAt) ||
    lastAt <= firstAt
  ) {
    return undefined;
  }
  const hours = (lastAt - firstAt) / (60 * 60 * 1000);
  if (!(hours > 0)) return undefined;
  return {
    window_minutes,
    quota_used_bytes_per_hour:
      ((last.quota_used_bytes ?? 0) - (first.quota_used_bytes ?? 0)) / hours,
  };
}

function overviewToHistoryPoint(
  overview: ProjectStorageOverview,
): ProjectStorageHistoryPoint {
  const quota = overview.quotas.find((entry) => entry.key === "project");
  return {
    collected_at: overview.collected_at,
    quota_used_bytes: quota?.used,
    quota_size_bytes: quota?.size,
    quota_used_percent: computePercent(quota?.used, quota?.size),
    live_bytes: overview.live.bytes,
    retained_bytes: overview.retained.bytes,
    home_visible_bytes:
      overview.visible.find((bucket) => bucket.key === "home")?.summaryBytes ??
      undefined,
    environment_visible_bytes:
      overview.visible.find((bucket) => bucket.key === "environment")
        ?.summaryBytes ?? undefined,
  };
}

function overviewHasRunningStorageScan(
  overview: ProjectStorageOverview,
): boolean {
  return overview.visible.some(
    (bucket) =>
      bucket.scan_status === "running" ||
      bucket.usage.scan_status === "running",
  );
}

async function getHistoryStream({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}): Promise<DStream<ProjectStorageHistoryPoint>> {
  const cached = historyStreams.get(project_id);
  if (cached && !cached.isClosed()) {
    return cached;
  }
  const inflight = historyStreamInflight.get(project_id);
  if (inflight) {
    return await inflight;
  }
  const promise = (async () => {
    const stream = await dstream<ProjectStorageHistoryPoint>({
      client,
      project_id,
      name: PROJECT_STORAGE_HISTORY_STREAM_NAME,
      noInventory: true,
    });
    await stream.config({ allow_msg_ttl: true });
    historyStreams.set(project_id, stream);
    return stream;
  })();
  historyStreamInflight.set(project_id, promise);
  try {
    return await promise;
  } finally {
    historyStreamInflight.delete(project_id);
  }
}

async function recordProjectStorageHistorySample({
  client,
  project_id,
  overview,
  force = false,
}: {
  client: Client;
  project_id: string;
  overview?: ProjectStorageOverview | null;
  force?: boolean;
}): Promise<void> {
  if (!project_id || !overview) return;
  const stream = await getHistoryStream({ client, project_id });
  const points = stream.getAll();
  const latest = points.at(-1);
  const collectedAt = Date.parse(overview.collected_at);
  if (
    !force &&
    latest?.collected_at &&
    Number.isFinite(collectedAt) &&
    Number.isFinite(Date.parse(latest.collected_at)) &&
    collectedAt - Date.parse(latest.collected_at) <
      STORAGE_HISTORY_SAMPLE_INTERVAL_MS
  ) {
    return;
  }
  stream.publish(overviewToHistoryPoint(overview), {
    ttl: STORAGE_HISTORY_TTL_MS,
  });
  await stream.save();
}

async function loadProjectStorageHistory({
  client,
  project_id,
  window_minutes,
  max_points,
}: {
  client: Client;
  project_id: string;
  window_minutes?: number;
  max_points?: number;
}): Promise<ProjectStorageHistory> {
  const windowMinutes = normalizeWindowMinutes(window_minutes);
  const maxPoints = normalizeMaxPoints(max_points);
  const cutoff = Date.now() - windowMinutes * 60_000;
  const stream = await getHistoryStream({ client, project_id });
  const allPoints = [...stream.getAll()]
    .filter((point) => {
      const at = Date.parse(`${point?.collected_at ?? ""}`);
      return Number.isFinite(at) && at >= cutoff;
    })
    .sort(
      (left, right) =>
        Date.parse(left.collected_at) - Date.parse(right.collected_at),
    );
  const points = compactPoints(allPoints, maxPoints);
  const growth = computeGrowth(allPoints, windowMinutes);
  return {
    window_minutes: windowMinutes,
    point_count: allPoints.length,
    points,
    ...(growth ? { growth } : {}),
  };
}

function localFs({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}) {
  return fsClient({
    client,
    subject: fsSubject({ project_id }),
    waitForInterest: false,
  });
}

async function getStorageBreakdownImpl({
  client,
  project_id,
  path,
  force_sample = false,
  fallback_bytes,
}: {
  client: Client;
  project_id: string;
  path: string;
  force_sample?: boolean;
  fallback_bytes?: number;
}): Promise<ProjectStorageBreakdown> {
  const normalizedPath = normalizeStoragePath(path);
  const cacheKey = storageBreakdownCacheKey({
    project_id,
    path: normalizedPath,
  });
  const cached = force_sample
    ? undefined
    : projectStorageBreakdownCache.get(cacheKey);
  if (cached) return cached;
  let scan = projectStorageBreakdownInflight.get(cacheKey);
  if (!scan) {
    const budget = claimProjectScanBudget(project_id);
    if (!budget) {
      logger.warn("getStorageBreakdown: project scan budget exhausted", {
        project_id,
        path: normalizedPath,
      });
      return fallbackStorageBreakdown({
        cacheKey,
        normalizedPath,
        fallback_bytes,
        warning: storageScanBudgetExhaustedMessage(),
        scan_status: "budget_exhausted",
      });
    }
    scan = (async () => {
      try {
        const fs = localFs({ client, project_id });
        const [hostPath, identityPath, output] = await Promise.all([
          typeof fs.canonicalSyncFsPath === "function"
            ? fs.canonicalSyncFsPath(normalizedPath).catch(() => normalizedPath)
            : Promise.resolve(normalizedPath),
          typeof fs.canonicalSyncIdentityPath === "function"
            ? fs
                .canonicalSyncIdentityPath(normalizedPath)
                .catch(() => normalizedPath)
            : Promise.resolve(normalizedPath),
          fs.du(normalizedPath, {
            // Use allocated bytes, not apparent/logical size. GNU du's
            // --bytes/-b implies --apparent-size, which badly overstates sparse
            // files such as PostgreSQL WAL archives.
            options: ["-B", "1", "-x", "-d", "1"],
            timeout: budget.timeout_ms,
          }),
        ]);
        const breakdown = parseDuOutput(output, normalizedPath, [
          identityPath,
          hostPath,
        ]);
        projectStorageBreakdownCache.set(cacheKey, breakdown);
        projectStorageBreakdownStaleCache.set(cacheKey, breakdown);
        return breakdown;
      } finally {
        budget.finish();
        if (projectStorageBreakdownInflight.get(cacheKey) === scan) {
          projectStorageBreakdownInflight.delete(cacheKey);
        }
      }
    })();
    projectStorageBreakdownInflight.set(cacheKey, scan);
    scan.catch((err) => {
      logger.warn("getStorageBreakdown: background scan failed", {
        project_id,
        path: normalizedPath,
        err,
      });
    });
  }
  try {
    return await waitForStorageScan({
      promise: scan,
      timeout_ms: PROJECT_STORAGE_BREAKDOWN_WAIT_MS,
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      logger.warn("getStorageBreakdown: returning fallback while scan runs", {
        project_id,
        path: normalizedPath,
      });
      return fallbackStorageBreakdown({
        cacheKey,
        normalizedPath,
        fallback_bytes,
        warning: storageScanBudgetMessage(normalizedPath),
        scan_status: "running",
      });
    }
    if (!isStorageScanBudgetError(err)) {
      throw err;
    }
    logger.warn("getStorageBreakdown: using fallback after scan failure", {
      project_id,
      path: normalizedPath,
      err,
    });
    return fallbackStorageBreakdown({
      cacheKey,
      normalizedPath,
      fallback_bytes,
      warning: storageScanFailedMessage(normalizedPath),
      scan_status: "failed",
    });
  }
}

async function getStorageOverviewImpl({
  client,
  project_id,
  home,
  force_sample,
}: {
  client: Client;
  project_id: string;
  home?: string;
  force_sample?: boolean;
}): Promise<ProjectStorageOverview> {
  const homePath = normalizeStoragePath(home || "/root");
  const cacheKey = storageOverviewCacheKey({ project_id, home: homePath });
  const requestedAt = new Date();
  const forced = !!force_sample;
  const lastForcedAt = projectStorageForceSampleAt.get(cacheKey) ?? 0;
  const nextAllowedAt =
    lastForcedAt + PROJECT_STORAGE_FORCE_SAMPLE_MIN_INTERVAL_MS;
  const forceAllowed = !forced || Date.now() >= nextAllowedAt;
  const refreshBase = forced
    ? {
        requested_at: requestedAt.toISOString(),
        ...(forceAllowed
          ? {}
          : { next_allowed_at: new Date(nextAllowedAt).toISOString() }),
      }
    : undefined;
  const cached = force_sample
    ? undefined
    : projectStorageOverviewCache.get(cacheKey);
  if (cached) return cached;
  const inflight = projectStorageOverviewInflight.get(cacheKey);
  if (inflight) {
    const overview = await inflight;
    return refreshBase
      ? {
          ...overview,
          refresh: {
            ...refreshBase,
            status: forced && !forceAllowed ? "rate_limited" : "inflight",
          },
        }
      : overview;
  }
  if (forced && !forceAllowed) {
    const cachedOverview = projectStorageOverviewCache.get(cacheKey);
    if (cachedOverview) {
      return {
        ...cachedOverview,
        refresh: {
          ...refreshBase!,
          status: "rate_limited",
        },
      };
    }
  }

  const load = (async () => {
    const environmentPath = posix.join(homePath, PROJECT_IMAGE_PATH);
    const fileServer = fileServerClient(client);
    const [quota, sharedScratch] = await Promise.all([
      fileServer.getQuota({ project_id }),
      getSharedScratchSummary().catch((err) => {
        logger.warn("getStorageOverview: unable to sample shared scratch", {
          project_id,
          err,
        });
        return undefined;
      }),
    ]);
    const [homeUsage, environmentUsage] = await Promise.all([
      getStorageBreakdownImpl({
        client,
        project_id,
        path: homePath,
        force_sample: forced && forceAllowed,
        fallback_bytes: quota.used,
      }),
      getStorageBreakdownImpl({
        client,
        project_id,
        path: environmentPath,
        force_sample: forced && forceAllowed,
      }).catch((err) => {
        const text = `${err ?? ""}`.toLowerCase();
        if (text.includes("no such file") || text.includes("not found")) {
          return null;
        }
        throw err;
      }),
    ]);

    const environmentBytes = Math.max(0, environmentUsage?.bytes ?? 0);
    const liveBytes = Math.max(0, homeUsage.bytes);

    const visible: ProjectStorageVisibleSummary[] = [
      {
        key: "home",
        label: homePath,
        summaryLabel: "Home",
        path: homePath,
        summaryBytes: Math.max(0, liveBytes - environmentBytes),
        usage: homeUsage,
        estimated: homeUsage.estimated,
        stale: homeUsage.stale,
        scan_status: homeUsage.scan_status,
        warning: homeUsage.warning,
      },
    ];
    if (environmentUsage != null) {
      visible.push({
        key: "environment",
        label: "Environment changes",
        summaryLabel: "Environment",
        path: environmentPath,
        summaryBytes: environmentUsage.bytes,
        usage: environmentUsage,
        estimated: environmentUsage.estimated,
        stale: environmentUsage.stale,
        scan_status: environmentUsage.scan_status,
        warning: environmentUsage.warning,
      });
    }

    const overview: ProjectStorageOverview = {
      collected_at: new Date().toISOString(),
      ...(refreshBase
        ? {
            refresh: {
              ...refreshBase,
              status: forceAllowed ? "sampled" : "rate_limited",
            } satisfies ProjectStorageOverviewRefresh,
          }
        : {}),
      quotas: [
        {
          key: "project",
          label: "Project quota",
          used: quota.used,
          size: quota.size,
          qgroupid: quota.qgroupid,
          scope: quota.scope,
          warning: quota.warning,
        },
      ],
      live: {
        key: "live",
        label: "Live files",
        path: homePath,
        bytes: liveBytes,
      },
      retained: buildRetainedSummary({
        quotaUsed: quota.used,
        liveBytes,
      }),
      ...(sharedScratch ? { shared_scratch: sharedScratch } : {}),
      visible,
    };
    try {
      await recordProjectStorageHistorySample({
        client,
        project_id,
        overview,
        force: forced && forceAllowed,
      });
    } catch (err) {
      logger.warn(
        "getStorageOverview: unable to record storage history sample",
        {
          project_id,
          err,
        },
      );
    }
    if (forced && forceAllowed) {
      projectStorageForceSampleAt.set(cacheKey, Date.now());
    }
    if (!overviewHasRunningStorageScan(overview)) {
      projectStorageOverviewCache.set(cacheKey, overview);
    }
    return overview;
  })();
  projectStorageOverviewInflight.set(cacheKey, load);
  try {
    return await load;
  } finally {
    if (projectStorageOverviewInflight.get(cacheKey) === load) {
      projectStorageOverviewInflight.delete(cacheKey);
    }
  }
}

async function getSnapshotUsageImpl({
  client,
  project_id,
}: {
  client: Client;
  project_id: string;
}) {
  const fileServer = fileServerClient(client);
  return await fileServer.allSnapshotUsage({ project_id });
}

export async function handleProjectDiskQuotaRequest(
  this: { subject?: string },
  _opts: undefined,
  client?: Client,
): Promise<ProjectDiskQuota> {
  if (client == null) {
    throw new Error("project disk quota requires a local conat client");
  }
  return await getDiskQuotaImpl({
    client,
    project_id: extractProjectId(this?.subject),
  });
}

export async function handleProjectStorageOverviewRequest(
  this: { subject?: string },
  opts?: { home?: string; force_sample?: boolean },
  client?: Client,
): Promise<ProjectStorageOverview> {
  if (client == null) {
    throw new Error("project storage overview requires a local conat client");
  }
  return await getStorageOverviewImpl({
    client,
    project_id: extractProjectId(this?.subject),
    home: opts?.home,
    force_sample: opts?.force_sample,
  });
}

export async function handleProjectSnapshotUsageRequest(
  this: { subject?: string },
  _opts: undefined,
  client?: Client,
) {
  if (client == null) {
    throw new Error("project snapshot usage requires a local conat client");
  }
  return await getSnapshotUsageImpl({
    client,
    project_id: extractProjectId(this?.subject),
  });
}

export async function handleProjectStorageBreakdownRequest(
  this: { subject?: string },
  opts: { path: string },
  client?: Client,
): Promise<ProjectStorageBreakdown> {
  if (client == null) {
    throw new Error("project storage breakdown requires a local conat client");
  }
  return await getStorageBreakdownImpl({
    client,
    project_id: extractProjectId(this?.subject),
    path: opts?.path,
  });
}

export async function handleProjectStorageHistoryRequest(
  this: { subject?: string },
  opts?: { window_minutes?: number; max_points?: number },
  client?: Client,
): Promise<ProjectStorageHistory> {
  if (client == null) {
    throw new Error("project storage history requires a local conat client");
  }
  return await loadProjectStorageHistory({
    client,
    project_id: extractProjectId(this?.subject),
    window_minutes: opts?.window_minutes,
    max_points: opts?.max_points,
  });
}

export async function initProjectStorageInfoService(client: Client) {
  logger.debug("starting project storage info service", {
    subject: PROJECT_STORAGE_INFO_SUBJECT,
  });
  return await client.service(PROJECT_STORAGE_INFO_SUBJECT, {
    getQuota() {
      return handleProjectDiskQuotaRequest.call(this, undefined, client);
    },
    getOverview(opts?: { home?: string; force_sample?: boolean }) {
      return handleProjectStorageOverviewRequest.call(this, opts, client);
    },
    getSnapshotUsage() {
      return handleProjectSnapshotUsageRequest.call(this, undefined, client);
    },
    getBreakdown(opts: { path: string }) {
      return handleProjectStorageBreakdownRequest.call(this, opts, client);
    },
    getHistory(opts?: { window_minutes?: number; max_points?: number }) {
      return handleProjectStorageHistoryRequest.call(this, opts, client);
    },
  });
}
