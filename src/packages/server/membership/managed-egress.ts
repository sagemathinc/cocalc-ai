/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  ManagedEgressEventSummary,
  ManagedEgressHistory,
  ManagedEgressHistoryBucketSize,
  ManagedEgressHistoryPoint,
  ManagedEgressProjectSummary,
} from "@cocalc/conat/hub/api/purchases";

const TABLE = "account_managed_egress_events";

export type ManagedProjectEgressCategory =
  | "file-download"
  | "http-proxy"
  | "ws-proxy"
  | "ssh"
  | "interactive-conat"
  | "raw-network";

type ManagedEgressUsage = {
  managed_egress_5h_bytes: number;
  managed_egress_7d_bytes: number;
  managed_egress_5h_remaining_bytes?: number;
  managed_egress_7d_remaining_bytes?: number;
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

let ensuredSchema: Promise<void> | undefined;

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
    })();
  }
  await ensuredSchema;
}

export async function getProjectOwnerAccountId(
  project_id: string,
): Promise<string | undefined> {
  const { rows } = await getPool("medium").query<{ account_id: string }>(
    `
      SELECT owner.key AS account_id
      FROM projects,
           LATERAL jsonb_each(COALESCE(users, '{}'::jsonb)) AS owner(key, value)
      WHERE project_id = $1
        AND deleted IS NULL
        AND owner.value ->> 'group' = 'owner'
      LIMIT 1
    `,
    [project_id],
  );
  return rows[0]?.account_id;
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
      ? await getProjectOwnerAccountId(opts.project_id!)
      : undefined);
  if (!account_id) {
    return { recorded: false };
  }
  await getPool("medium").query(
    `
      INSERT INTO ${TABLE}
        (id, account_id, project_id, category, bytes, metadata, occurred_at)
      VALUES
        (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, COALESCE($6, now()))
    `,
    [
      account_id,
      `${opts.project_id ?? ""}`.trim() || null,
      opts.category,
      bytes,
      opts.metadata ?? null,
      opts.occurred_at ?? null,
    ],
  );
  return { recorded: true, account_id };
}

export async function getManagedEgressUsageForAccount(opts: {
  account_id: string;
  limit5h?: number;
  limit7d?: number;
}): Promise<ManagedEgressUsage> {
  await ensureSchema();
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
              WHEN occurred_at >= now() - interval '5 hours' THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_5h,
        COALESCE(
          SUM(
            CASE
              WHEN occurred_at >= now() - interval '7 days' THEN bytes
              ELSE 0
            END
          ),
          0
        ) AS bytes_7d
      FROM ${TABLE}
      WHERE account_id = $1
        AND occurred_at >= now() - interval '7 days'
      GROUP BY category
      ORDER BY category
    `,
    [opts.account_id],
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

  const [managed_egress_5h_reset_at, managed_egress_7d_reset_at] =
    await Promise.all([
      getManagedEgressWindowResetAt({
        account_id: opts.account_id,
        period: "5 hours",
      }),
      getManagedEgressWindowResetAt({
        account_id: opts.account_id,
        period: "7 days",
      }),
    ]);

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

async function getManagedEgressWindowResetAt({
  account_id,
  period,
}: {
  account_id: string;
  period: "5 hours" | "7 days";
}): Promise<Date | undefined> {
  const { rows } = await getPool("short").query<{
    occurred_at?: string | Date;
  }>(
    `
      SELECT occurred_at
      FROM ${TABLE}
      WHERE account_id = $1
        AND occurred_at >= now() - interval '${period}'
      ORDER BY occurred_at ASC
      LIMIT 1
    `,
    [account_id],
  );
  const oldest = rows[0]?.occurred_at;
  if (!oldest) return;
  const oldestMs = new Date(oldest).getTime();
  if (!Number.isFinite(oldestMs)) return;
  const windowMs =
    period === "5 hours" ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  return new Date(oldestMs + windowMs);
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
  const params: Array<string | number | Date | null> = [opts.account_id];
  const where: string[] = ["events.account_id = $1"];
  if (`${opts.project_id ?? ""}`.trim()) {
    params.push(`${opts.project_id}`.trim());
    where.push(`events.project_id = $${params.length}`);
  }
  const start = parseOptionalTimestamp(opts.start);
  if (start) {
    params.push(start);
    where.push(`events.occurred_at >= $${params.length}`);
  }
  const end = parseOptionalTimestamp(opts.end);
  if (end) {
    params.push(end);
    where.push(`events.occurred_at < $${params.length}`);
  }
  params.push(limit);
  const { rows } = await getPool("medium").query<{
    account_id: string;
    project_id?: string | null;
    project_title?: string | null;
    category: string;
    bytes: string | number;
    occurred_at: Date | string;
    metadata: Record<string, unknown> | null;
  }>(
    `
      SELECT
        events.account_id,
        events.project_id,
        projects.title AS project_title,
        events.category,
        events.bytes,
        events.occurred_at,
        events.metadata
      FROM ${TABLE} AS events
      LEFT JOIN projects ON projects.project_id = events.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY events.occurred_at DESC, events.id DESC
      LIMIT $${params.length}
    `,
    params,
  );
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
    "events.occurred_at >= $2",
    "events.occurred_at < $3",
  ];
  const params: Array<string | Date> = [
    opts.account_id,
    query.startDate,
    query.endDate,
  ];
  if (query.project_id) {
    params.push(query.project_id);
    where.push(`events.project_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const bucketExpr = getBucketSql(query.bucket);

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
          FROM ${TABLE} AS events
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
          FROM ${TABLE} AS events
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
            events.project_id,
            projects.title AS project_title,
            COALESCE(SUM(events.bytes), 0) AS bytes
          FROM ${TABLE} AS events
          LEFT JOIN projects ON projects.project_id = events.project_id
          WHERE ${whereSql}
          GROUP BY events.project_id, projects.title
          ORDER BY bytes DESC, events.project_id ASC NULLS LAST
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

function getBucketSql(bucket: ManagedEgressHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "to_timestamp(floor(extract(epoch from events.occurred_at) / 300) * 300)";
    case "1h":
      return "to_timestamp(floor(extract(epoch from events.occurred_at) / 3600) * 3600)";
    case "1d":
      return "date_trunc('day', events.occurred_at)";
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
