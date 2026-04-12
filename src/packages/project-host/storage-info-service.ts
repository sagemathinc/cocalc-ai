/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { posix } from "node:path";
import TTL from "@isaacs/ttlcache";
import getLogger from "@cocalc/backend/logger";
import type { Client } from "@cocalc/conat/core/client";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import { fsClient, fsSubject, type ExecOutput } from "@cocalc/conat/files/fs";
import { dstream, type DStream } from "@cocalc/conat/sync/dstream";
import type {
  ProjectStorageBreakdown,
  ProjectStorageCountedSummary,
  ProjectStorageHistory,
  ProjectStorageHistoryGrowth,
  ProjectStorageHistoryPoint,
  ProjectStorageOverview,
  ProjectStorageVisibleSummary,
} from "@cocalc/conat/hub/api/projects";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import { human_readable_size } from "@cocalc/util/misc";
import { fileServerClient } from "./file-server";

const logger = getLogger("project-host:storage-info");

export const PROJECT_STORAGE_INFO_SUBJECT = "project.*.storage-info.-";
export const PROJECT_STORAGE_HISTORY_STREAM_NAME = "project-storage-history";

const PROJECT_STORAGE_CACHE_TTL_MS = 30_000;
const PROJECT_STORAGE_BREAKDOWN_TIMEOUT_MS = 10_000;
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

function parseDustOutput(
  output: ExecOutput,
  path: string,
): ProjectStorageBreakdown {
  const { stdout, stderr, code, truncated } = output;
  const errText = Buffer.from(stderr).toString().trim();
  if (truncated) {
    throw new Error(
      `Disk usage scan for '${path}' took too long on this large folder. Browse into a smaller folder and try again.`,
    );
  }
  if (code) {
    throw new Error(errText || `dust failed for ${path}`);
  }
  const text = Buffer.from(stdout).toString();
  if (!text.trim()) {
    throw new Error(
      errText ||
        `Disk usage scan for '${path}' returned incomplete data. Try again or browse into a smaller folder.`,
    );
  }
  let parsed: {
    size: string;
    name: string;
    children?: { size: string; name: string }[];
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Disk usage scan for '${path}' returned invalid data. Try again or browse into a smaller folder.`,
    );
  }
  const requestedPath = posix.normalize(path);
  const scannedRoot = posix.normalize(parsed.name);
  return {
    path: requestedPath,
    bytes: parseInt(parsed.size.slice(0, -1)),
    children: (parsed.children ?? []).map(({ size, name }) => ({
      bytes: parseInt(size.slice(0, -1)),
      path: posix.relative(scannedRoot, posix.normalize(name)),
    })),
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
    home_visible_bytes:
      overview.visible.find((bucket) => bucket.key === "home")?.summaryBytes ??
      undefined,
    scratch_visible_bytes:
      overview.visible.find((bucket) => bucket.key === "scratch")
        ?.summaryBytes ?? undefined,
    environment_visible_bytes:
      overview.visible.find((bucket) => bucket.key === "environment")
        ?.summaryBytes ?? undefined,
    snapshot_counted_bytes:
      overview.counted.find((entry) => entry.key === "snapshots")?.bytes ??
      undefined,
  };
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
    waitForInterest: true,
  });
}

async function getStorageBreakdownImpl({
  client,
  project_id,
  path,
}: {
  client: Client;
  project_id: string;
  path: string;
}): Promise<ProjectStorageBreakdown> {
  const normalizedPath = normalizeStoragePath(path);
  const cacheKey = storageBreakdownCacheKey({
    project_id,
    path: normalizedPath,
  });
  const cached = projectStorageBreakdownCache.get(cacheKey);
  if (cached) return cached;
  const breakdown = parseDustOutput(
    await localFs({ client, project_id }).dust(normalizedPath, {
      options: ["-j", "-x", "-d", "1", "-s", "-o", "b", "-P"],
      timeout: PROJECT_STORAGE_BREAKDOWN_TIMEOUT_MS,
    }),
    normalizedPath,
  );
  projectStorageBreakdownCache.set(cacheKey, breakdown);
  return breakdown;
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
  const cached = force_sample
    ? undefined
    : projectStorageOverviewCache.get(cacheKey);
  if (cached) return cached;

  const environmentPath = posix.join(homePath, PROJECT_IMAGE_PATH);
  const fileServer = fileServerClient(client);
  const [quota, homeUsage, scratchUsage, environmentUsage, snapshotUsage] =
    await Promise.all([
      fileServer.getQuota({ project_id }),
      getStorageBreakdownImpl({ client, project_id, path: homePath }),
      getStorageBreakdownImpl({ client, project_id, path: "/scratch" }).catch(
        (err) => {
          const text = `${err ?? ""}`.toLowerCase();
          if (
            text.includes("scratch is not mounted") ||
            text.includes("no such file") ||
            text.includes("not found")
          ) {
            return null;
          }
          throw err;
        },
      ),
      getStorageBreakdownImpl({
        client,
        project_id,
        path: environmentPath,
      }).catch((err) => {
        const text = `${err ?? ""}`.toLowerCase();
        if (text.includes("no such file") || text.includes("not found")) {
          return null;
        }
        throw err;
      }),
      fileServer.allSnapshotUsage({ project_id }),
    ]);

  const visible: ProjectStorageVisibleSummary[] = [
    {
      key: "home",
      label: homePath,
      summaryLabel: "Home",
      path: homePath,
      summaryBytes: Math.max(
        0,
        homeUsage.bytes - Math.max(0, environmentUsage?.bytes ?? 0),
      ),
      usage: homeUsage,
    },
  ];
  if (scratchUsage != null) {
    visible.push({
      key: "scratch",
      label: "/scratch",
      summaryLabel: "Scratch",
      path: "/scratch",
      summaryBytes: scratchUsage.bytes,
      usage: scratchUsage,
    });
  }
  if (environmentUsage != null) {
    visible.push({
      key: "environment",
      label: "Environment changes",
      summaryLabel: "Environment",
      path: environmentPath,
      summaryBytes: environmentUsage.bytes,
      usage: environmentUsage,
    });
  }

  const snapshotExclusiveBytes = snapshotUsage.reduce(
    (sum, snapshot) => sum + Math.max(0, snapshot.exclusive ?? 0),
    0,
  );
  const counted: ProjectStorageCountedSummary[] = [];
  if (snapshotExclusiveBytes >= 1 << 20) {
    const snapshotCount = snapshotUsage.length;
    const largestExclusiveBytes = snapshotUsage.reduce(
      (max, snapshot) => Math.max(max, Math.max(0, snapshot.exclusive ?? 0)),
      0,
    );
    counted.push({
      key: "snapshots",
      label: "Snapshots",
      bytes: snapshotExclusiveBytes,
      compactLabel: "Snapshots",
      detail:
        snapshotCount <= 1
          ? "This snapshot currently holds counted storage that would be freed if it is deleted."
          : `Across ${snapshotCount} snapshots, this is storage referenced only by snapshots. The largest single snapshot currently has about ${human_readable_size(largestExclusiveBytes)} of exclusive data, and exact savings from deleting one snapshot depend on overlap.`,
    });
  }

  const overview: ProjectStorageOverview = {
    collected_at: new Date().toISOString(),
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
    visible,
    counted,
  };
  try {
    await recordProjectStorageHistorySample({
      client,
      project_id,
      overview,
      force: !!force_sample,
    });
  } catch (err) {
    logger.warn("getStorageOverview: unable to record storage history sample", {
      project_id,
      err,
    });
  }
  projectStorageOverviewCache.set(cacheKey, overview);
  return overview;
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
    getOverview(opts?: { home?: string; force_sample?: boolean }) {
      return handleProjectStorageOverviewRequest.call(this, opts, client);
    },
    getBreakdown(opts: { path: string }) {
      return handleProjectStorageBreakdownRequest.call(this, opts, client);
    },
    getHistory(opts?: { window_minutes?: number; max_points?: number }) {
      return handleProjectStorageHistoryRequest.call(this, opts, client);
    },
  });
}
