/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  RootfsQuotaDenialSummary,
  RootfsQuotaReport,
  RootfsQuotaUsageRow,
} from "@cocalc/conat/hub/api/system";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveMembershipForAccount } from "./resolve";

const BYTES_PER_GB = 1_000_000_000;
const SIZE_EXPRESSION =
  "GREATEST(0, COALESCE(rel.size_bytes, ROUND(COALESCE(img.size_gb, 0) * 1000000000)::BIGINT, 0))";

function boundedPositiveInteger({
  value,
  fallback,
  max,
}: {
  value?: number;
  fallback: number;
  max: number;
}): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function boundedPercent(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 80;
  return Math.min(Math.max(parsed, 1), 100);
}

function optionalFilter(value: unknown): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || undefined;
}

function finiteNonnegativeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function gbLimitToBytes(value: unknown): number | null {
  const gb = finiteNonnegativeNumber(value);
  return gb == null ? null : Math.floor(gb * BYTES_PER_GB);
}

function ratio(current: number, maximum: number | null): number | null {
  if (maximum == null) return null;
  if (maximum <= 0) return current > 0 ? 1 : 0;
  return current / maximum;
}

function dateToIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const text = `${value ?? ""}`;
  return text ? new Date(text).toISOString() : null;
}

function parseUsageRow(row: Record<string, any>): RootfsQuotaUsageRow {
  return {
    account_id: row.account_id,
    count: Math.max(0, Math.floor(Number(row.count) || 0)),
    total_storage_bytes: Math.max(
      0,
      Math.floor(Number(row.total_storage_bytes) || 0),
    ),
    max_rootfs_bytes: Math.max(
      0,
      Math.floor(Number(row.max_rootfs_bytes) || 0),
    ),
    last_updated: dateToIso(row.last_updated),
  };
}

async function loadUsageRows({
  limit,
  user_account_id,
  order,
}: {
  limit: number;
  user_account_id?: string | null;
  order: "storage" | "count";
}): Promise<RootfsQuotaUsageRow[]> {
  const params: any[] = [];
  const conditions = [
    "img.owner_id IS NOT NULL",
    "COALESCE(img.deleted, false)=false",
  ];
  const accountId = optionalFilter(user_account_id);
  if (accountId) {
    params.push(accountId);
    conditions.push(`img.owner_id=$${params.length}`);
  }
  params.push(limit);
  const limitParam = params.length;
  const orderBy =
    order === "count"
      ? "count DESC, total_storage_bytes DESC"
      : "total_storage_bytes DESC, count DESC";

  const { rows } = await getPool("medium").query(
    `SELECT
        img.owner_id AS account_id,
        COUNT(*)::int AS count,
        COALESCE(SUM(${SIZE_EXPRESSION}), 0)::bigint AS total_storage_bytes,
        COALESCE(MAX(${SIZE_EXPRESSION}), 0)::bigint AS max_rootfs_bytes,
        MAX(img.updated) AS last_updated
       FROM rootfs_images AS img
       LEFT JOIN rootfs_releases AS rel ON rel.release_id = img.release_id
      WHERE ${conditions.join(" AND ")}
      GROUP BY img.owner_id
      ORDER BY ${orderBy}
      LIMIT $${limitParam}`,
    params,
  );
  return rows.map(parseUsageRow);
}

async function addMembershipLimits(
  row: RootfsQuotaUsageRow,
): Promise<RootfsQuotaUsageRow> {
  const resolution = await resolveMembershipForAccount(row.account_id);
  const limits = getEffectiveMembershipUsageLimits(resolution);
  const countLimit = finiteNonnegativeNumber(limits.rootfs_count);
  const totalStorageLimit = gbLimitToBytes(limits.rootfs_total_storage_gb);
  const maxStorageLimit = gbLimitToBytes(limits.rootfs_max_storage_gb);
  return {
    ...row,
    rootfs_count_limit: countLimit,
    rootfs_total_storage_bytes_limit: totalStorageLimit,
    rootfs_max_storage_bytes_limit: maxStorageLimit,
    count_ratio: ratio(row.count, countLimit),
    total_storage_ratio: ratio(row.total_storage_bytes, totalStorageLimit),
    max_rootfs_ratio: ratio(row.max_rootfs_bytes, maxStorageLimit),
  };
}

function isNearLimit(row: RootfsQuotaUsageRow, threshold: number): boolean {
  return (
    (row.count_ratio ?? 0) >= threshold ||
    (row.total_storage_ratio ?? 0) >= threshold ||
    (row.max_rootfs_ratio ?? 0) >= threshold
  );
}

function parseDenialRow(row: Record<string, any>): RootfsQuotaDenialSummary {
  return {
    account_id: row.account_id || null,
    limit: row.denial_limit || "unknown",
    operation: row.operation || "unknown",
    reason: row.reason || null,
    count: Number(row.count) || 0,
    first_time:
      row.first_time instanceof Date
        ? row.first_time.toISOString()
        : `${row.first_time}`,
    last_time:
      row.last_time instanceof Date
        ? row.last_time.toISOString()
        : `${row.last_time}`,
    max_current: Number(row.max_current) || 0,
    max_maximum: Number(row.max_maximum) || 0,
    max_requested: Number(row.max_requested) || 0,
    sample_image: row.sample_image || null,
    sample_image_id: row.sample_image_id || null,
  };
}

async function loadDenials({
  windowMinutes,
  minCount,
  limit,
  user_account_id,
  denial_limit,
  operation,
}: {
  windowMinutes: number;
  minCount: number;
  limit: number;
  user_account_id?: string | null;
  denial_limit?: string | null;
  operation?: string | null;
}): Promise<RootfsQuotaDenialSummary[]> {
  const params: any[] = [windowMinutes];
  const conditions = [
    "event = 'rootfs_quota_denied'",
    `"time" >= NOW() - ($1::int * INTERVAL '1 minute')`,
  ];
  const addFilter = (jsonKey: string, value: unknown) => {
    const filter = optionalFilter(value);
    if (!filter) return;
    params.push(filter);
    conditions.push(`value->>'${jsonKey}' = $${params.length}`);
  };
  addFilter("account_id", user_account_id);
  addFilter("limit", denial_limit);
  addFilter("operation", operation);
  params.push(minCount, limit);
  const minCountParam = params.length - 1;
  const limitParam = params.length;

  const { rows } = await getPool().query(
    `WITH filtered AS (
        SELECT "time", value
        FROM central_log
        WHERE ${conditions.join(" AND ")}
      )
      SELECT
        NULLIF(value->>'account_id', '') AS account_id,
        COALESCE(NULLIF(value->>'limit', ''), 'unknown') AS denial_limit,
        COALESCE(NULLIF(value->>'operation', ''), 'unknown') AS operation,
        NULLIF(value->>'reason', '') AS reason,
        COUNT(*)::int AS count,
        MIN("time") AS first_time,
        MAX("time") AS last_time,
        MAX(
          CASE
            WHEN (value->>'current') ~ '^[0-9]+$'
            THEN (value->>'current')::int
            ELSE 0
          END
        )::int AS max_current,
        MAX(
          CASE
            WHEN (value->>'maximum') ~ '^[0-9]+$'
            THEN (value->>'maximum')::int
            ELSE 0
          END
        )::int AS max_maximum,
        MAX(
          CASE
            WHEN (value->>'requested') ~ '^[0-9]+$'
            THEN (value->>'requested')::int
            ELSE 0
          END
        )::int AS max_requested,
        MAX(NULLIF(value->>'image', '')) AS sample_image,
        MAX(NULLIF(value->>'image_id', '')) AS sample_image_id
      FROM filtered
      GROUP BY account_id, denial_limit, operation, reason
      HAVING COUNT(*) >= $${minCountParam}
      ORDER BY count DESC, last_time DESC
      LIMIT $${limitParam}`,
    params,
  );
  return rows.map(parseDenialRow);
}

export async function getRootfsQuotaReport({
  window_minutes,
  min_count,
  limit,
  near_percent,
  user_account_id,
  denial_limit,
  operation,
}: {
  window_minutes?: number;
  min_count?: number;
  limit?: number;
  near_percent?: number;
  user_account_id?: string | null;
  denial_limit?: string | null;
  operation?: string | null;
} = {}): Promise<RootfsQuotaReport> {
  const rowLimit = boundedPositiveInteger({
    value: limit,
    fallback: 50,
    max: 500,
  });
  const windowMinutes = boundedPositiveInteger({
    value: window_minutes,
    fallback: 60,
    max: 7 * 24 * 60,
  });
  const minCount = boundedPositiveInteger({
    value: min_count,
    fallback: 1,
    max: 1_000_000,
  });
  const nearPercent = boundedPercent(near_percent);
  const candidateLimit = Math.min(rowLimit * 4, 1_000);
  const byStorage = await loadUsageRows({
    limit: candidateLimit,
    user_account_id,
    order: "storage",
  });
  const byCount = await loadUsageRows({
    limit: candidateLimit,
    user_account_id,
    order: "count",
  });
  const usageByAccount = new Map<string, RootfsQuotaUsageRow>();
  for (const row of [...byStorage, ...byCount]) {
    usageByAccount.set(row.account_id, row);
  }
  const withLimits = await Promise.all(
    [...usageByAccount.values()].map(addMembershipLimits),
  );
  const topUsers = [...withLimits]
    .sort(
      (a, b) =>
        b.total_storage_bytes - a.total_storage_bytes || b.count - a.count,
    )
    .slice(0, rowLimit);
  const nearThreshold = nearPercent / 100;
  const nearLimitUsers = [...withLimits]
    .filter((row) => isNearLimit(row, nearThreshold))
    .sort((a, b) => {
      const aRatio = Math.max(
        a.count_ratio ?? 0,
        a.total_storage_ratio ?? 0,
        a.max_rootfs_ratio ?? 0,
      );
      const bRatio = Math.max(
        b.count_ratio ?? 0,
        b.total_storage_ratio ?? 0,
        b.max_rootfs_ratio ?? 0,
      );
      return bRatio - aRatio || b.total_storage_bytes - a.total_storage_bytes;
    })
    .slice(0, rowLimit);
  const checkedAt = new Date();
  return {
    checked_at: checkedAt.toISOString(),
    since: new Date(checkedAt.valueOf() - windowMinutes * 60_000).toISOString(),
    window_minutes: windowMinutes,
    min_count: minCount,
    near_percent: nearPercent,
    top_users: topUsers,
    near_limit_users: nearLimitUsers,
    denials: await loadDenials({
      windowMinutes,
      minCount,
      limit: rowLimit,
      user_account_id,
      denial_limit,
      operation,
    }),
  };
}
