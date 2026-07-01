/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import LRU from "lru-cache";
import type {
  AbuseReviewAnnotation,
  ManagedEgressAccountSummary,
  ManagedEgressAdminHistory,
  ManagedEgressAdminOverview,
  ManagedEgressAdminProjectSummary,
  ManagedEgressEventSummary,
  ManagedEgressHistory,
  ManagedEgressHistoryBucketSize,
  ManagedEgressHistoryPoint,
  ManagedEgressProjectSummary,
} from "@cocalc/conat/hub/api/purchases";
import { listActiveAbuseReviewAnnotations } from "./abuse-review-annotations";
import { getProjectUsageAccountId } from "./project-usage";
import { getAdminAccountMembershipStatusMap } from "./admin-account-status";
import {
  ensureAccountUsageWindowsForEvent,
  getActiveAccountUsageWindows,
} from "./usage-windows";

export {
  getProjectOwnerAccountId,
  getProjectUsageAccountId,
} from "./project-usage";

const TABLE = "account_managed_egress_events";
const ROLLUP_TABLE = "account_managed_egress_rollups";
const NO_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
const ROLLUP_FLUSH_INTERVAL_MS = 60_000;
const ROLLUP_FLUSH_MAX_PENDING = 1000;
const QUOTA_EXCLUDED_CATEGORIES = new Set<ManagedProjectEgressCategory>([
  "interactive-conat",
]);

export type ManagedProjectEgressCategory =
  | "file-download"
  | "http-proxy"
  | "ws-proxy"
  | "ssh"
  | "interactive-conat"
  | "raw-network"
  | "backup-upload";

type ManagedEgressUsage = {
  managed_egress_5h_bytes: number;
  managed_egress_7d_bytes: number;
  managed_egress_5h_remaining_bytes?: number;
  managed_egress_7d_remaining_bytes?: number;
  managed_egress_5h_starts_at?: Date;
  managed_egress_7d_starts_at?: Date;
  managed_egress_5h_reset_at?: Date;
  managed_egress_7d_reset_at?: Date;
  managed_egress_5h_reset_in?: string;
  managed_egress_7d_reset_in?: string;
  over_managed_egress_5h?: boolean;
  over_managed_egress_7d?: boolean;
  managed_egress_categories_5h_bytes: Record<string, number>;
  managed_egress_categories_7d_bytes: Record<string, number>;
};

const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_BUCKETS = 2000;
const ADMIN_OVERVIEW_CACHE_TTL_MS = 60_000;

const logger = getLogger("server:membership:managed-egress");

let ensuredSchema: Promise<void> | undefined;
let adminTimeIndexReady: Promise<void> | undefined;
let rollupFlushTimer: ReturnType<typeof setTimeout> | undefined;
let rollupFlushPromise: Promise<void> | undefined;

type ManagedEgressAdminOverviewBase = {
  total_bytes: number;
  categories_bytes: Record<string, number>;
  top_accounts: ManagedEgressAccountSummary[];
  top_projects: ManagedEgressAdminProjectSummary[];
  recent_events: ManagedEgressEventSummary[];
};

type PendingManagedEgressRollup = {
  bucket_start: Date;
  account_id: string;
  project_id?: string;
  category: ManagedProjectEgressCategory;
  bytes: number;
  event_count: number;
  first_occurred_at: Date;
  last_occurred_at: Date;
  metadata_sample?: Record<string, unknown>;
};

const pendingRollups = new Map<string, PendingManagedEgressRollup>();

const adminOverviewCache = new LRU<
  string,
  Promise<ManagedEgressAdminOverviewBase>
>({
  max: 100,
  ttl: ADMIN_OVERVIEW_CACHE_TTL_MS,
});

async function createIndexConcurrentlyBestEffort({
  name,
  sql,
}: {
  name: string;
  sql: string;
}): Promise<void> {
  const pool = getPool();
  if (typeof (pool as any).connect !== "function") {
    await pool.query(sql.replace("CREATE INDEX CONCURRENTLY", "CREATE INDEX"));
    return;
  }
  const client = await (pool as any).connect();
  let locked = false;
  try {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [name],
    );
    locked = rows[0]?.locked === true;
    if (!locked) {
      return;
    }
    await client.query(sql);
  } catch (err) {
    logger.warn("failed to create admin overview index", {
      index: name,
      err: `${err}`,
    });
  } finally {
    if (locked) {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", [name])
        .catch(() => undefined);
    }
    client.release();
  }
}

function ensureAdminTimeIndexBestEffort(): void {
  adminTimeIndexReady ??= createIndexConcurrentlyBestEffort({
    name: `${TABLE}_time_admin_idx`,
    sql: `
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ${TABLE}_time_admin_idx
      ON ${TABLE}(occurred_at DESC, id DESC)
      INCLUDE (account_id, project_id, category, bytes)
    `,
  });
  adminTimeIndexReady.catch(() => undefined);
}

function rollupProjectIdSql(alias = "events"): string {
  return `NULLIF(${alias}.project_id, '${NO_PROJECT_ID}'::uuid)`;
}

function rollupBucketStart(occurred_at?: Date): Date {
  const at = occurred_at ?? new Date();
  return new Date(Math.floor(at.getTime() / 60000) * 60000);
}

function rollupKey({
  bucket_start,
  account_id,
  project_id,
  category,
}: {
  bucket_start: Date;
  account_id: string;
  project_id?: string;
  category: ManagedProjectEgressCategory;
}): string {
  return [
    bucket_start.toISOString(),
    account_id,
    `${project_id ?? ""}`.trim() || NO_PROJECT_ID,
    category,
  ].join(":");
}

function mergePendingRollup(entry: PendingManagedEgressRollup): void {
  const key = rollupKey(entry);
  const existing = pendingRollups.get(key);
  if (existing == null) {
    pendingRollups.set(key, entry);
    return;
  }
  existing.bytes += entry.bytes;
  existing.event_count += entry.event_count;
  if (entry.first_occurred_at < existing.first_occurred_at) {
    existing.first_occurred_at = entry.first_occurred_at;
  }
  if (entry.last_occurred_at > existing.last_occurred_at) {
    existing.last_occurred_at = entry.last_occurred_at;
  }
  existing.metadata_sample ??= entry.metadata_sample;
}

function scheduleManagedEgressRollupFlush(): void {
  if (rollupFlushTimer != null) return;
  rollupFlushTimer = setTimeout(() => {
    rollupFlushTimer = undefined;
    flushManagedEgressRollups().catch(() => undefined);
  }, ROLLUP_FLUSH_INTERVAL_MS);
  rollupFlushTimer.unref?.();
}

async function flushManagedEgressRollups(): Promise<void> {
  if (rollupFlushPromise != null) {
    return await rollupFlushPromise;
  }
  if (rollupFlushTimer != null) {
    clearTimeout(rollupFlushTimer);
    rollupFlushTimer = undefined;
  }
  const batch = [...pendingRollups.values()];
  pendingRollups.clear();
  if (batch.length === 0) return;
  rollupFlushPromise = flushManagedEgressRollupBatch(batch)
    .catch((err) => {
      logger.warn("failed to flush managed egress rollups", {
        count: batch.length,
        err: `${err}`,
      });
      for (const entry of batch) {
        mergePendingRollup(entry);
      }
      scheduleManagedEgressRollupFlush();
    })
    .finally(() => {
      rollupFlushPromise = undefined;
      if (pendingRollups.size > 0) {
        scheduleManagedEgressRollupFlush();
      }
    });
  return await rollupFlushPromise;
}

async function ensureSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL,
          project_id UUID,
          category TEXT NOT NULL,
          bytes BIGINT NOT NULL,
          metadata JSONB,
          occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      try {
        await getPool().query(
          `ALTER TABLE ${TABLE} ALTER COLUMN project_id DROP NOT NULL`,
        );
      } catch {}
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_time_idx ON ${TABLE}(account_id, occurred_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_project_time_idx ON ${TABLE}(project_id, occurred_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_category_time_idx ON ${TABLE}(category, occurred_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_project_time_idx ON ${TABLE}(account_id, project_id, occurred_at DESC)`,
      );
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${ROLLUP_TABLE} (
          bucket_start TIMESTAMPTZ NOT NULL,
          account_id UUID NOT NULL,
          project_id UUID NOT NULL DEFAULT '${NO_PROJECT_ID}'::uuid,
          category TEXT NOT NULL,
          bytes BIGINT NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0,
          first_occurred_at TIMESTAMPTZ NOT NULL,
          last_occurred_at TIMESTAMPTZ NOT NULL,
          metadata_sample JSONB,
          PRIMARY KEY (bucket_start, account_id, project_id, category)
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${ROLLUP_TABLE}_account_time_idx ON ${ROLLUP_TABLE}(account_id, bucket_start DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${ROLLUP_TABLE}_project_time_idx ON ${ROLLUP_TABLE}(project_id, bucket_start DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${ROLLUP_TABLE}_category_time_idx ON ${ROLLUP_TABLE}(category, bucket_start DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${ROLLUP_TABLE}_time_idx ON ${ROLLUP_TABLE}(bucket_start DESC)`,
      );
      ensureAdminTimeIndexBestEffort();
    })();
  }
  await ensuredSchema;
}

async function recordManagedProjectEgressRollup({
  account_id,
  project_id,
  category,
  bytes,
  metadata,
  occurred_at,
}: {
  account_id: string;
  project_id?: string;
  category: ManagedProjectEgressCategory;
  bytes: number;
  metadata?: Record<string, unknown>;
  occurred_at?: Date;
}): Promise<void> {
  const bucket_start = rollupBucketStart(occurred_at);
  const eventTime = occurred_at ?? new Date();
  mergePendingRollup({
    bucket_start,
    account_id,
    project_id: `${project_id ?? ""}`.trim() || undefined,
    category,
    bytes,
    event_count: 1,
    first_occurred_at: eventTime,
    last_occurred_at: eventTime,
    metadata_sample: metadata,
  });
  if (pendingRollups.size >= ROLLUP_FLUSH_MAX_PENDING) {
    await flushManagedEgressRollups();
  } else {
    scheduleManagedEgressRollupFlush();
  }
}

async function flushManagedEgressRollupBatch(
  batch: PendingManagedEgressRollup[],
): Promise<void> {
  await getPool("medium").query(
    `
      WITH input AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS entry(
          bucket_start timestamptz,
          account_id uuid,
          project_id uuid,
          category text,
          bytes bigint,
          event_count integer,
          first_occurred_at timestamptz,
          last_occurred_at timestamptz,
          metadata_sample jsonb
        )
      )
      INSERT INTO ${ROLLUP_TABLE}
        (
          bucket_start,
          account_id,
          project_id,
          category,
          bytes,
          event_count,
          first_occurred_at,
          last_occurred_at,
          metadata_sample
        )
      SELECT
        bucket_start,
        account_id,
        COALESCE(project_id, '${NO_PROJECT_ID}'::uuid),
        category,
        bytes,
        event_count,
        first_occurred_at,
        last_occurred_at,
        metadata_sample
      FROM input
      ON CONFLICT (bucket_start, account_id, project_id, category)
      DO UPDATE SET
        bytes = ${ROLLUP_TABLE}.bytes + EXCLUDED.bytes,
        event_count = ${ROLLUP_TABLE}.event_count + EXCLUDED.event_count,
        first_occurred_at = LEAST(${ROLLUP_TABLE}.first_occurred_at, EXCLUDED.first_occurred_at),
        last_occurred_at = GREATEST(${ROLLUP_TABLE}.last_occurred_at, EXCLUDED.last_occurred_at),
        metadata_sample = COALESCE(${ROLLUP_TABLE}.metadata_sample, EXCLUDED.metadata_sample)
    `,
    [
      JSON.stringify(
        batch.map((entry) => ({
          bucket_start: entry.bucket_start.toISOString(),
          account_id: entry.account_id,
          project_id: entry.project_id ?? null,
          category: entry.category,
          bytes: entry.bytes,
          event_count: entry.event_count,
          first_occurred_at: entry.first_occurred_at.toISOString(),
          last_occurred_at: entry.last_occurred_at.toISOString(),
          metadata_sample: entry.metadata_sample ?? null,
        })),
      ),
    ],
  );
}

export async function recordManagedProjectEgress(opts: {
  account_id?: string;
  project_id?: string;
  category: ManagedProjectEgressCategory;
  bytes: number;
  metadata?: Record<string, unknown>;
  occurred_at?: Date;
}): Promise<{ recorded: boolean; account_id?: string }> {
  const bytes = Math.floor(Number(opts.bytes) || 0);
  if (bytes <= 0) {
    return { recorded: false };
  }
  await ensureSchema();
  const account_id =
    `${opts.account_id ?? ""}`.trim() ||
    (`${opts.project_id ?? ""}`.trim()
      ? await getProjectUsageAccountId(opts.project_id!)
      : undefined);
  if (!account_id) {
    return { recorded: false };
  }
  if (!QUOTA_EXCLUDED_CATEGORIES.has(opts.category)) {
    await ensureAccountUsageWindowsForEvent({
      account_id,
      occurred_at: opts.occurred_at,
    });
  }
  await recordManagedProjectEgressRollup({
    account_id,
    project_id: opts.project_id,
    category: opts.category,
    bytes,
    metadata: opts.metadata,
    occurred_at: opts.occurred_at,
  });
  return { recorded: true, account_id };
}

export async function getManagedEgressUsageForAccount(opts: {
  account_id: string;
  limit5h?: number;
  limit7d?: number;
}): Promise<ManagedEgressUsage> {
  await ensureSchema();
  const windows = await getActiveAccountUsageWindows({
    account_id: opts.account_id,
  });
  const window5h = windows["5h"];
  const window7d = windows["7d"];
  const { rows } = await getPool("medium").query<{
    category: string;
    bytes_5h: string | number;
    bytes_7d: string | number;
  }>(
    `
      SELECT
        category,
        COALESCE(
          SUM(
            CASE
              WHEN $2::timestamptz IS NOT NULL
               AND bucket_start >= $2::timestamptz
               AND bucket_start < $3::timestamptz THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_5h,
        COALESCE(
          SUM(
            CASE
              WHEN $4::timestamptz IS NOT NULL
               AND bucket_start >= $4::timestamptz
               AND bucket_start < $5::timestamptz THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_7d
      FROM ${ROLLUP_TABLE}
      WHERE account_id = $1
        AND category <> ALL($6::text[])
        AND (
          ($2::timestamptz IS NOT NULL AND bucket_start >= $2::timestamptz AND bucket_start < $3::timestamptz)
          OR ($4::timestamptz IS NOT NULL AND bucket_start >= $4::timestamptz AND bucket_start < $5::timestamptz)
        )
      GROUP BY category
      ORDER BY category
    `,
    [
      opts.account_id,
      window5h?.starts_at ?? null,
      window5h?.resets_at ?? null,
      window7d?.starts_at ?? null,
      window7d?.resets_at ?? null,
      [...QUOTA_EXCLUDED_CATEGORIES],
    ],
  );

  const managed_egress_categories_5h_bytes: Record<string, number> = {};
  const managed_egress_categories_7d_bytes: Record<string, number> = {};
  let managed_egress_5h_bytes = 0;
  let managed_egress_7d_bytes = 0;
  for (const row of rows) {
    const bytes5h = Math.max(0, Number(row.bytes_5h) || 0);
    const bytes7d = Math.max(0, Number(row.bytes_7d) || 0);
    managed_egress_categories_5h_bytes[row.category] = bytes5h;
    managed_egress_categories_7d_bytes[row.category] = bytes7d;
    managed_egress_5h_bytes += bytes5h;
    managed_egress_7d_bytes += bytes7d;
  }

  const managed_egress_5h_reset_at = window5h?.resets_at;
  const managed_egress_7d_reset_at = window7d?.resets_at;

  return {
    managed_egress_5h_bytes,
    managed_egress_7d_bytes,
    managed_egress_5h_remaining_bytes:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? opts.limit5h - managed_egress_5h_bytes
        : undefined,
    managed_egress_7d_remaining_bytes:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? opts.limit7d - managed_egress_7d_bytes
        : undefined,
    managed_egress_5h_starts_at: window5h?.starts_at,
    managed_egress_7d_starts_at: window7d?.starts_at,
    managed_egress_5h_reset_at,
    managed_egress_7d_reset_at,
    managed_egress_5h_reset_in:
      managed_egress_5h_reset_at != null
        ? formatDuration(
            Math.max(0, managed_egress_5h_reset_at.getTime() - Date.now()),
          ) || undefined
        : undefined,
    managed_egress_7d_reset_in:
      managed_egress_7d_reset_at != null
        ? formatDuration(
            Math.max(0, managed_egress_7d_reset_at.getTime() - Date.now()),
          ) || undefined
        : undefined,
    over_managed_egress_5h:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? managed_egress_5h_bytes > opts.limit5h
        : undefined,
    over_managed_egress_7d:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? managed_egress_7d_bytes > opts.limit7d
        : undefined,
    managed_egress_categories_5h_bytes,
    managed_egress_categories_7d_bytes,
  };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalMinutes = Math.ceil(ms / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days == 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours == 1 ? "" : "s"}`);
  if (days == 0 && hours == 0 && minutes > 0) {
    parts.push(`${minutes} minute${minutes == 1 ? "" : "s"}`);
  }
  return parts.join(" ");
}

export async function getRecentManagedEgressEventsForAccount(opts: {
  account_id: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  limit?: number;
}): Promise<ManagedEgressEventSummary[]> {
  await ensureSchema();
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.min(50, Math.floor(opts.limit)))
      : 20;
  const params: Array<string | number | Date | string[] | null> = [
    opts.account_id,
  ];
  const where: string[] = ["events.account_id = $1"];
  if (`${opts.project_id ?? ""}`.trim()) {
    params.push(`${opts.project_id}`.trim());
    where.push(`events.project_id = $${params.length}`);
  }
  const start = parseOptionalTimestamp(opts.start);
  if (start) {
    params.push(start);
    where.push(`events.bucket_start >= $${params.length}`);
  }
  const end = parseOptionalTimestamp(opts.end);
  if (end) {
    params.push(end);
    where.push(`events.bucket_start < $${params.length}`);
  }
  params.push([...QUOTA_EXCLUDED_CATEGORIES]);
  where.push(`events.category <> ALL($${params.length}::text[])`);
  params.push(limit);
  const { rows } = await getPool("medium").query<RawManagedEgressEventRow>(
    `
      SELECT
        events.account_id,
        ${rollupProjectIdSql("events")} AS project_id,
        projects.title AS project_title,
        events.category,
        events.bytes,
        events.last_occurred_at AS occurred_at,
        events.metadata_sample AS metadata
      FROM ${ROLLUP_TABLE} AS events
      LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
      WHERE ${where.join(" AND ")}
      ORDER BY events.last_occurred_at DESC, events.bucket_start DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return mapManagedEgressEventRows(rows);
}

function adminOverviewCacheKey(
  query: ReturnType<typeof normalizeOverviewQuery>,
): string {
  return [
    Math.floor(query.startDate.getTime() / ADMIN_OVERVIEW_CACHE_TTL_MS),
    Math.floor(query.endDate.getTime() / ADMIN_OVERVIEW_CACHE_TTL_MS),
    query.recent_event_limit,
    query.top_account_limit,
    query.top_project_limit,
  ].join(":");
}

async function getManagedEgressAdminOverviewBase(
  query: ReturnType<typeof normalizeOverviewQuery>,
): Promise<ManagedEgressAdminOverviewBase> {
  const key = adminOverviewCacheKey(query);
  const cached = adminOverviewCache.get(key);
  if (cached != null) {
    return await cached;
  }
  const promise = getManagedEgressAdminOverviewBaseUncached(query).catch(
    (err) => {
      adminOverviewCache.delete(key);
      throw err;
    },
  );
  adminOverviewCache.set(key, promise);
  return await promise;
}

async function getManagedEgressAdminOverviewBaseUncached(
  query: ReturnType<typeof normalizeOverviewQuery>,
): Promise<ManagedEgressAdminOverviewBase> {
  const whereSql =
    "events.bucket_start >= $1 AND events.bucket_start < $2 AND events.category <> ALL($3::text[])";
  const params: Array<Date | string[]> = [
    query.startDate,
    query.endDate,
    [...QUOTA_EXCLUDED_CATEGORIES],
  ];

  const [
    categoryRowsResult,
    accountRowsResult,
    projectRowsResult,
    recentEventsResult,
  ] = await Promise.all([
    getPool("medium").query<{
      category: string;
      bytes: string | number;
    }>(
      `
        SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        WHERE ${whereSql}
        GROUP BY events.category
        ORDER BY events.category
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      banned: boolean | null;
      bytes: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned
        ORDER BY bytes DESC, events.account_id ASC
        LIMIT ${Math.max(1, Math.min(query.top_account_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      banned: boolean | null;
      project_id: string | null;
      project_title: string | null;
      bytes: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          ${rollupProjectIdSql("events")} AS project_id,
          projects.title AS project_title,
          COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          events.project_id,
          projects.title
        ORDER BY bytes DESC, projects.title ASC NULLS LAST, project_id ASC NULLS LAST
        LIMIT ${Math.max(1, Math.min(query.top_project_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<RawManagedEgressEventRow>(
      `
        SELECT
          events.account_id,
          ${rollupProjectIdSql("events")} AS project_id,
          projects.title AS project_title,
          events.category,
          events.bytes,
          events.last_occurred_at AS occurred_at,
          events.metadata_sample AS metadata
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
        WHERE ${whereSql}
        ORDER BY events.last_occurred_at DESC, events.bucket_start DESC
        LIMIT ${Math.max(1, Math.min(query.recent_event_limit, 100))}
      `,
      params,
    ),
  ]);

  const categories_bytes: Record<string, number> = {};
  let total_bytes = 0;
  for (const row of categoryRowsResult.rows) {
    const bytes = Math.max(0, Number(row.bytes) || 0);
    categories_bytes[row.category] = bytes;
    total_bytes += bytes;
  }

  const top_accounts: ManagedEgressAccountSummary[] =
    accountRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      display_name: row.display_name ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      banned: row.banned ?? false,
      bytes: Math.max(0, Number(row.bytes) || 0),
    }));

  const top_projects: ManagedEgressAdminProjectSummary[] =
    projectRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      display_name: row.display_name ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      banned: row.banned ?? false,
      project_id: row.project_id ?? null,
      project_title: row.project_title ?? null,
      bytes: Math.max(0, Number(row.bytes) || 0),
    }));

  return {
    total_bytes,
    categories_bytes,
    top_accounts,
    top_projects,
    recent_events: mapManagedEgressEventRows(recentEventsResult.rows),
  };
}

export async function getManagedEgressAdminOverview(opts: {
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): Promise<ManagedEgressAdminOverview> {
  await ensureSchema();
  const query = normalizeOverviewQuery(opts);
  const base = await getManagedEgressAdminOverviewBase(query);
  const top_accounts = base.top_accounts.map((account) => ({ ...account }));
  const top_projects = base.top_projects.map((project) => ({ ...project }));
  const accountIds = [
    ...top_accounts.map((account) => account.account_id),
    ...top_projects.map((project) => project.account_id),
  ];
  const [activeAnnotations, membershipStatuses] = await Promise.all([
    listActiveAbuseReviewAnnotations({
      account_ids: accountIds,
      project_ids: top_projects.map((project) => project.project_id),
      categories: ["egress", "general"],
    }),
    getAdminAccountMembershipStatusMap(accountIds),
  ]);
  attachMembershipStatus(top_accounts, membershipStatuses);
  attachMembershipStatus(top_projects, membershipStatuses);

  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    total_bytes: base.total_bytes,
    categories_bytes: { ...base.categories_bytes },
    top_accounts: attachActiveAnnotationsToEgressAccounts(
      top_accounts,
      activeAnnotations,
    ),
    top_projects: attachActiveAnnotationsToEgressProjects(
      top_projects,
      activeAnnotations,
    ),
    recent_events: base.recent_events.map((event) => ({ ...event })),
  };
}

export async function getManagedEgressAdminHistory(opts: {
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): Promise<ManagedEgressAdminHistory> {
  await ensureSchema();
  const query = normalizeAdminHistoryQuery(opts);
  const whereSql =
    "events.bucket_start >= $1 AND events.bucket_start < $2 AND events.category <> ALL($3::text[])";
  const params: Array<Date | string[]> = [
    query.startDate,
    query.endDate,
    [...QUOTA_EXCLUDED_CATEGORIES],
  ];
  const bucketExpr = getBucketSql(query.bucket, "events.bucket_start");

  const [
    categoryRowsResult,
    bucketRowsResult,
    accountRowsResult,
    projectRowsResult,
    recentEventsResult,
  ] = await Promise.all([
    getPool("medium").query<{
      category: string;
      bytes: string | number;
    }>(
      `
        SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        WHERE ${whereSql}
        GROUP BY events.category
        ORDER BY events.category
      `,
      params,
    ),
    getPool("medium").query<{
      bucket_start: Date | string;
      category: string;
      bytes: string | number;
    }>(
      `
        SELECT
          ${bucketExpr} AS bucket_start,
          events.category,
          COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        WHERE ${whereSql}
        GROUP BY bucket_start, events.category
        ORDER BY bucket_start ASC, events.category ASC
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      banned: boolean | null;
      bytes: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned
        ORDER BY bytes DESC, events.account_id ASC
        LIMIT ${Math.max(1, Math.min(query.top_account_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      banned: boolean | null;
      project_id: string | null;
      project_title: string | null;
      bytes: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          ${rollupProjectIdSql("events")} AS project_id,
          projects.title AS project_title,
          COALESCE(SUM(events.bytes), 0) AS bytes
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.display_name,
          accounts.first_name,
          accounts.last_name,
          accounts.banned,
          events.project_id,
          projects.title
        ORDER BY bytes DESC, projects.title ASC NULLS LAST, project_id ASC NULLS LAST
        LIMIT ${Math.max(1, Math.min(query.top_project_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<RawManagedEgressEventRow>(
      `
        SELECT
          events.account_id,
          ${rollupProjectIdSql("events")} AS project_id,
          projects.title AS project_title,
          events.category,
          events.bytes,
          events.last_occurred_at AS occurred_at,
          events.metadata_sample AS metadata
        FROM ${ROLLUP_TABLE} AS events
        LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
        WHERE ${whereSql}
        ORDER BY events.last_occurred_at DESC, events.bucket_start DESC
        LIMIT ${Math.max(1, Math.min(query.recent_event_limit, 100))}
      `,
      params,
    ),
  ]);

  const categories_bytes: Record<string, number> = {};
  let total_bytes = 0;
  for (const row of categoryRowsResult.rows) {
    const bytes = Math.max(0, Number(row.bytes) || 0);
    categories_bytes[row.category] = bytes;
    total_bytes += bytes;
  }

  const bucketData = new Map<string, ManagedEgressHistoryPoint>();
  for (const point of buildEmptyHistoryPoints({
    start: query.startDate,
    end: query.endDate,
    bucket: query.bucket,
  })) {
    bucketData.set(point.start, point);
  }
  for (const row of bucketRowsResult.rows) {
    const bucketStart = new Date(row.bucket_start).toISOString();
    const point = bucketData.get(bucketStart);
    if (!point) continue;
    const bytes = Math.max(0, Number(row.bytes) || 0);
    point.categories_bytes[row.category] = bytes;
    point.bytes += bytes;
  }

  const top_accounts: ManagedEgressAccountSummary[] =
    accountRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      display_name: row.display_name ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      banned: row.banned ?? false,
      bytes: Math.max(0, Number(row.bytes) || 0),
    }));

  const top_projects: ManagedEgressAdminProjectSummary[] =
    projectRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      display_name: row.display_name ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      banned: row.banned ?? false,
      project_id: row.project_id ?? null,
      project_title: row.project_title ?? null,
      bytes: Math.max(0, Number(row.bytes) || 0),
    }));
  const accountIds = [
    ...top_accounts.map((account) => account.account_id),
    ...top_projects.map((project) => project.account_id),
  ];
  const [activeAnnotations, membershipStatuses] = await Promise.all([
    listActiveAbuseReviewAnnotations({
      account_ids: accountIds,
      project_ids: top_projects.map((project) => project.project_id),
      categories: ["egress", "general"],
    }),
    getAdminAccountMembershipStatusMap(accountIds),
  ]);
  attachMembershipStatus(top_accounts, membershipStatuses);
  attachMembershipStatus(top_projects, membershipStatuses);

  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    bucket: query.bucket,
    total_bytes,
    categories_bytes,
    points: [...bucketData.values()],
    top_accounts: attachActiveAnnotationsToEgressAccounts(
      top_accounts,
      activeAnnotations,
    ),
    top_projects: attachActiveAnnotationsToEgressProjects(
      top_projects,
      activeAnnotations,
    ),
    recent_events: mapManagedEgressEventRows(recentEventsResult.rows),
  };
}

export async function getManagedEgressHistoryForAccount(opts: {
  account_id: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_project_limit?: number;
}): Promise<ManagedEgressHistory> {
  await ensureSchema();
  const query = normalizeHistoryQuery(opts);
  const where: string[] = [
    "events.account_id = $1",
    "events.bucket_start >= $2",
    "events.bucket_start < $3",
  ];
  const params: Array<string | Date | string[]> = [
    opts.account_id,
    query.startDate,
    query.endDate,
  ];
  if (query.project_id) {
    params.push(query.project_id);
    where.push(`events.project_id = $${params.length}`);
  }
  params.push([...QUOTA_EXCLUDED_CATEGORIES]);
  where.push(`events.category <> ALL($${params.length}::text[])`);
  const whereSql = where.join(" AND ");
  const bucketExpr = getBucketSql(query.bucket, "events.bucket_start");

  const [
    categoryRowsResult,
    bucketRowsResult,
    projectRowsResult,
    recentEvents,
  ] = await Promise.all([
    getPool("medium").query<{
      category: string;
      bytes: string | number;
    }>(
      `
          SELECT events.category, COALESCE(SUM(events.bytes), 0) AS bytes
          FROM ${ROLLUP_TABLE} AS events
          WHERE ${whereSql}
          GROUP BY events.category
          ORDER BY events.category
        `,
      params,
    ),
    getPool("medium").query<{
      bucket_start: Date | string;
      category: string;
      bytes: string | number;
    }>(
      `
          SELECT
            ${bucketExpr} AS bucket_start,
            events.category,
            COALESCE(SUM(events.bytes), 0) AS bytes
          FROM ${ROLLUP_TABLE} AS events
          WHERE ${whereSql}
          GROUP BY bucket_start, events.category
          ORDER BY bucket_start ASC, events.category ASC
        `,
      params,
    ),
    getPool("medium").query<{
      project_id: string | null;
      project_title: string | null;
      bytes: string | number;
    }>(
      `
          SELECT
            ${rollupProjectIdSql("events")} AS project_id,
            projects.title AS project_title,
            COALESCE(SUM(events.bytes), 0) AS bytes
          FROM ${ROLLUP_TABLE} AS events
          LEFT JOIN projects ON projects.project_id = ${rollupProjectIdSql("events")}
          WHERE ${whereSql}
          GROUP BY events.project_id, projects.title
          ORDER BY bytes DESC, project_id ASC NULLS LAST
          LIMIT ${Math.max(1, Math.min(query.top_project_limit, 50))}
        `,
      params,
    ),
    getRecentManagedEgressEventsForAccount({
      account_id: opts.account_id,
      project_id: query.project_id,
      start: query.startDate,
      end: query.endDate,
      limit: query.recent_event_limit,
    }),
  ]);

  const categories_bytes: Record<string, number> = {};
  let total_bytes = 0;
  for (const row of categoryRowsResult.rows) {
    const bytes = Math.max(0, Number(row.bytes) || 0);
    categories_bytes[row.category] = bytes;
    total_bytes += bytes;
  }

  const bucketData = new Map<string, ManagedEgressHistoryPoint>();
  for (const point of buildEmptyHistoryPoints({
    start: query.startDate,
    end: query.endDate,
    bucket: query.bucket,
  })) {
    bucketData.set(point.start, point);
  }
  for (const row of bucketRowsResult.rows) {
    const bucketStart = new Date(row.bucket_start).toISOString();
    const point = bucketData.get(bucketStart);
    if (!point) continue;
    const bytes = Math.max(0, Number(row.bytes) || 0);
    point.categories_bytes[row.category] = bytes;
    point.bytes += bytes;
  }

  const top_projects: ManagedEgressProjectSummary[] =
    projectRowsResult.rows.map((row) => ({
      project_id: row.project_id ?? null,
      project_title: row.project_title ?? null,
      bytes: Math.max(0, Number(row.bytes) || 0),
    }));

  return {
    account_id: opts.account_id,
    project_id: query.project_id ?? null,
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    bucket: query.bucket,
    total_bytes,
    categories_bytes,
    points: [...bucketData.values()],
    top_projects,
    recent_events: recentEvents,
  };
}

function parseOptionalTimestamp(value?: string | Date): Date | undefined {
  if (value == null || value === "") return;
  const parsed = value instanceof Date ? value : new Date(value);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) {
    throw new Error("invalid timestamp");
  }
  return new Date(ms);
}

type RawManagedEgressEventRow = {
  account_id: string;
  project_id?: string | null;
  project_title?: string | null;
  category: string;
  bytes: string | number;
  occurred_at: Date | string;
  metadata: Record<string, unknown> | null;
};

function mapManagedEgressEventRows(
  rows: RawManagedEgressEventRow[],
): ManagedEgressEventSummary[] {
  return rows.map((row) => ({
    account_id: row.account_id,
    project_id: row.project_id ?? null,
    project_title: row.project_title ?? null,
    category: row.category,
    bytes: Math.max(0, Number(row.bytes) || 0),
    occurred_at: new Date(row.occurred_at).toISOString(),
    metadata: row.metadata ?? null,
  }));
}

function activeAnnotationsFor({
  annotations,
  account_id,
  project_id,
}: {
  annotations: AbuseReviewAnnotation[];
  account_id: string;
  project_id?: string | null;
}): AbuseReviewAnnotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.account_id === account_id &&
      (annotation.project_id == null || annotation.project_id === project_id),
  );
}

function attachActiveAnnotationsToEgressAccounts(
  accounts: ManagedEgressAccountSummary[],
  annotations: AbuseReviewAnnotation[],
): ManagedEgressAccountSummary[] {
  return accounts.map((account) => ({
    ...account,
    active_abuse_annotations: activeAnnotationsFor({
      annotations,
      account_id: account.account_id,
    }),
  }));
}

function attachActiveAnnotationsToEgressProjects(
  projects: ManagedEgressAdminProjectSummary[],
  annotations: AbuseReviewAnnotation[],
): ManagedEgressAdminProjectSummary[] {
  return projects.map((project) => ({
    ...project,
    active_abuse_annotations: activeAnnotationsFor({
      annotations,
      account_id: project.account_id,
      project_id: project.project_id,
    }),
  }));
}

function attachMembershipStatus<
  T extends {
    account_id: string;
    membership_class?: string | null;
    membership_label?: string | null;
    membership_source?: string | null;
  },
>(
  accounts: T[],
  statuses: Awaited<ReturnType<typeof getAdminAccountMembershipStatusMap>>,
): void {
  for (const account of accounts) {
    const status = statuses.get(account.account_id);
    account.membership_class = status?.membership_class ?? "free";
    account.membership_label = status?.membership_label ?? "Free";
    account.membership_source = status?.membership_source ?? "free";
  }
}

function normalizeWindowBounds(opts: {
  start?: string | Date;
  end?: string | Date;
}): {
  startDate: Date;
  endDate: Date;
} {
  const endDate = parseOptionalTimestamp(opts.end) ?? new Date();
  const startDate =
    parseOptionalTimestamp(opts.start) ??
    new Date(endDate.getTime() - DEFAULT_HISTORY_WINDOW_MS);
  if (!(endDate.getTime() > startDate.getTime())) {
    throw new Error("end must be after start");
  }
  if (endDate.getTime() - startDate.getTime() > MAX_HISTORY_WINDOW_MS) {
    throw new Error("history window must be at most 31 days");
  }
  return { startDate, endDate };
}

function normalizeHistoryQuery(opts: {
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_project_limit?: number;
}): {
  project_id?: string;
  startDate: Date;
  endDate: Date;
  bucket: ManagedEgressHistoryBucketSize;
  recent_event_limit: number;
  top_project_limit: number;
} {
  const { startDate, endDate } = normalizeWindowBounds(opts);
  const bucket = opts.bucket ?? "1h";
  const bucketMs = getBucketMs(bucket);
  if (
    Math.ceil((endDate.getTime() - startDate.getTime()) / bucketMs) >
    MAX_HISTORY_BUCKETS
  ) {
    throw new Error(
      "history query is too granular for the requested time range",
    );
  }
  return {
    project_id: `${opts.project_id ?? ""}`.trim() || undefined,
    startDate,
    endDate,
    bucket,
    recent_event_limit:
      typeof opts.recent_event_limit === "number" &&
      Number.isFinite(opts.recent_event_limit)
        ? Math.max(1, Math.min(100, Math.floor(opts.recent_event_limit)))
        : 20,
    top_project_limit:
      typeof opts.top_project_limit === "number" &&
      Number.isFinite(opts.top_project_limit)
        ? Math.max(1, Math.min(50, Math.floor(opts.top_project_limit)))
        : 10,
  };
}

function normalizeOverviewQuery(opts: {
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): {
  startDate: Date;
  endDate: Date;
  recent_event_limit: number;
  top_account_limit: number;
  top_project_limit: number;
} {
  const { startDate, endDate } = normalizeWindowBounds(opts);
  return {
    startDate,
    endDate,
    recent_event_limit:
      typeof opts.recent_event_limit === "number" &&
      Number.isFinite(opts.recent_event_limit)
        ? Math.max(1, Math.min(100, Math.floor(opts.recent_event_limit)))
        : 10,
    top_account_limit:
      typeof opts.top_account_limit === "number" &&
      Number.isFinite(opts.top_account_limit)
        ? Math.max(1, Math.min(50, Math.floor(opts.top_account_limit)))
        : 10,
    top_project_limit:
      typeof opts.top_project_limit === "number" &&
      Number.isFinite(opts.top_project_limit)
        ? Math.max(1, Math.min(50, Math.floor(opts.top_project_limit)))
        : 10,
  };
}

function normalizeAdminHistoryQuery(opts: {
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedEgressHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): {
  startDate: Date;
  endDate: Date;
  bucket: ManagedEgressHistoryBucketSize;
  recent_event_limit: number;
  top_account_limit: number;
  top_project_limit: number;
} {
  const { startDate, endDate } = normalizeWindowBounds(opts);
  const bucket = opts.bucket ?? "1h";
  const bucketMs = getBucketMs(bucket);
  if (
    Math.ceil((endDate.getTime() - startDate.getTime()) / bucketMs) >
    MAX_HISTORY_BUCKETS
  ) {
    throw new Error(
      "history query is too granular for the requested time range",
    );
  }
  return {
    startDate,
    endDate,
    bucket,
    recent_event_limit:
      typeof opts.recent_event_limit === "number" &&
      Number.isFinite(opts.recent_event_limit)
        ? Math.max(1, Math.min(100, Math.floor(opts.recent_event_limit)))
        : 20,
    top_account_limit:
      typeof opts.top_account_limit === "number" &&
      Number.isFinite(opts.top_account_limit)
        ? Math.max(1, Math.min(50, Math.floor(opts.top_account_limit)))
        : 10,
    top_project_limit:
      typeof opts.top_project_limit === "number" &&
      Number.isFinite(opts.top_project_limit)
        ? Math.max(1, Math.min(50, Math.floor(opts.top_project_limit)))
        : 10,
  };
}

function getBucketMs(bucket: ManagedEgressHistoryBucketSize): number {
  switch (bucket) {
    case "5m":
      return 5 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
  }
}

function getBucketSql(
  bucket: ManagedEgressHistoryBucketSize,
  column = "events.occurred_at",
): string {
  switch (bucket) {
    case "5m":
      return `to_timestamp(floor(extract(epoch from ${column}) / 300) * 300)`;
    case "1h":
      return `to_timestamp(floor(extract(epoch from ${column}) / 3600) * 3600)`;
    case "1d":
      return `date_trunc('day', ${column})`;
  }
}

function buildEmptyHistoryPoints({
  start,
  end,
  bucket,
}: {
  start: Date;
  end: Date;
  bucket: ManagedEgressHistoryBucketSize;
}): ManagedEgressHistoryPoint[] {
  const bucketMs = getBucketMs(bucket);
  const firstBucketStartMs = Math.floor(start.getTime() / bucketMs) * bucketMs;
  const points: ManagedEgressHistoryPoint[] = [];
  for (
    let currentStartMs = firstBucketStartMs;
    currentStartMs < end.getTime();
    currentStartMs += bucketMs
  ) {
    const currentEndMs = Math.min(currentStartMs + bucketMs, end.getTime());
    points.push({
      start: new Date(currentStartMs).toISOString(),
      end: new Date(currentEndMs).toISOString(),
      bytes: 0,
      categories_bytes: {},
    });
  }
  return points;
}
