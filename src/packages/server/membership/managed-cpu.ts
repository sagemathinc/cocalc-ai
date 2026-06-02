/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type {
  AbuseReviewAnnotation,
  ManagedCpuAccountSummary,
  ManagedCpuAdminHistory,
  ManagedCpuAdminOverview,
  ManagedCpuAdminProjectSummary,
  ManagedCpuEventSummary,
  ManagedCpuHistoryBucketSize,
  ManagedCpuHistoryPoint,
} from "@cocalc/conat/hub/api/purchases";
import { getProjectUsageAccountId } from "./project-usage";
import { listActiveAbuseReviewAnnotations } from "./abuse-review-annotations";
import {
  ensureAccountUsageWindowsForEvent,
  getActiveAccountUsageWindows,
} from "./usage-windows";

const TABLE = "account_cpu_usage_events";
const DEFAULT_HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_WINDOW_MS = 31 * 24 * 60 * 60 * 1000;
const MAX_HISTORY_BUCKETS = 2000;

export type ManagedCpuUsage = {
  managed_cpu_5h_seconds: number;
  managed_cpu_7d_seconds: number;
  managed_cpu_5h_remaining_seconds?: number;
  managed_cpu_7d_remaining_seconds?: number;
  managed_cpu_5h_starts_at?: Date;
  managed_cpu_7d_starts_at?: Date;
  managed_cpu_5h_reset_at?: Date;
  managed_cpu_7d_reset_at?: Date;
  managed_cpu_5h_reset_in?: string;
  managed_cpu_7d_reset_in?: string;
  over_managed_cpu_5h?: boolean;
  over_managed_cpu_7d?: boolean;
};

let ensuredSchema: Promise<void> | undefined;

async function ensureSchema(): Promise<void> {
  if (!ensuredSchema) {
    ensuredSchema = (async () => {
      await getPool().query(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id UUID PRIMARY KEY,
          account_id UUID NOT NULL,
          project_id UUID,
          host_id UUID,
          cpu_seconds DOUBLE PRECISION NOT NULL,
          sample_started_at TIMESTAMPTZ,
          sample_ended_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          source TEXT NOT NULL DEFAULT 'project-host-cgroup',
          metadata JSONB
        )
      `);
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_time_idx ON ${TABLE}(account_id, sample_ended_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_project_time_idx ON ${TABLE}(project_id, sample_ended_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_host_time_idx ON ${TABLE}(host_id, sample_ended_at DESC)`,
      );
      await getPool().query(
        `CREATE INDEX IF NOT EXISTS ${TABLE}_account_project_time_idx ON ${TABLE}(account_id, project_id, sample_ended_at DESC)`,
      );
    })();
  }
  await ensuredSchema;
}

function normalizeCpuSeconds(value: unknown): number {
  const cpuSeconds = Number(value);
  return Number.isFinite(cpuSeconds) && cpuSeconds > 0 ? cpuSeconds : 0;
}

export async function recordManagedProjectCpuUsage(opts: {
  account_id?: string;
  project_id?: string;
  host_id?: string;
  cpu_seconds: number;
  sample_started_at?: Date;
  sample_ended_at?: Date;
  source?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ recorded: boolean; account_id?: string }> {
  const cpuSeconds = normalizeCpuSeconds(opts.cpu_seconds);
  if (cpuSeconds <= 0) {
    return { recorded: false };
  }
  await ensureSchema();
  const project_id = `${opts.project_id ?? ""}`.trim() || undefined;
  const account_id =
    `${opts.account_id ?? ""}`.trim() ||
    (project_id ? await getProjectUsageAccountId(project_id) : undefined);
  if (!account_id) {
    return { recorded: false };
  }
  await ensureAccountUsageWindowsForEvent({
    account_id,
    occurred_at: opts.sample_ended_at,
  });
  await getPool("medium").query(
    `
      INSERT INTO ${TABLE}
        (
          id,
          account_id,
          project_id,
          host_id,
          cpu_seconds,
          sample_started_at,
          sample_ended_at,
          source,
          metadata
        )
      VALUES
        (
          gen_random_uuid(),
          $1,
          $2,
          $3,
          $4,
          $5,
          COALESCE($6, now()),
          COALESCE($7, 'project-host-cgroup'),
          $8::jsonb
        )
    `,
    [
      account_id,
      project_id ?? null,
      `${opts.host_id ?? ""}`.trim() || null,
      cpuSeconds,
      opts.sample_started_at ?? null,
      opts.sample_ended_at ?? null,
      `${opts.source ?? ""}`.trim() || "project-host-cgroup",
      opts.metadata ?? null,
    ],
  );
  return { recorded: true, account_id };
}

export async function getManagedCpuUsageForAccount(opts: {
  account_id: string;
  limit5h?: number;
  limit7d?: number;
}): Promise<ManagedCpuUsage> {
  await ensureSchema();
  const windows = await getActiveAccountUsageWindows({
    account_id: opts.account_id,
  });
  const window5h = windows["5h"];
  const window7d = windows["7d"];
  const { rows } = await getPool("medium").query<{
    seconds_5h: string | number;
    seconds_7d: string | number;
  }>(
    `
      SELECT
        COALESCE(
          SUM(
            CASE
              WHEN $2::timestamptz IS NOT NULL
               AND sample_ended_at >= $2::timestamptz
               AND sample_ended_at < $3::timestamptz THEN cpu_seconds
              ELSE 0
            END
          ),
          0
        ) AS seconds_5h,
        COALESCE(
          SUM(
            CASE
              WHEN $4::timestamptz IS NOT NULL
               AND sample_ended_at >= $4::timestamptz
               AND sample_ended_at < $5::timestamptz THEN cpu_seconds
              ELSE 0
            END
          ),
          0
        ) AS seconds_7d
      FROM ${TABLE}
      WHERE account_id = $1
        AND (
          ($2::timestamptz IS NOT NULL AND sample_ended_at >= $2::timestamptz AND sample_ended_at < $3::timestamptz)
          OR ($4::timestamptz IS NOT NULL AND sample_ended_at >= $4::timestamptz AND sample_ended_at < $5::timestamptz)
        )
    `,
    [
      opts.account_id,
      window5h?.starts_at ?? null,
      window5h?.resets_at ?? null,
      window7d?.starts_at ?? null,
      window7d?.resets_at ?? null,
    ],
  );
  const managed_cpu_5h_seconds = normalizeCpuSeconds(rows[0]?.seconds_5h);
  const managed_cpu_7d_seconds = normalizeCpuSeconds(rows[0]?.seconds_7d);
  const managed_cpu_5h_reset_at = window5h?.resets_at;
  const managed_cpu_7d_reset_at = window7d?.resets_at;

  return {
    managed_cpu_5h_seconds,
    managed_cpu_7d_seconds,
    managed_cpu_5h_remaining_seconds:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? opts.limit5h - managed_cpu_5h_seconds
        : undefined,
    managed_cpu_7d_remaining_seconds:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? opts.limit7d - managed_cpu_7d_seconds
        : undefined,
    managed_cpu_5h_starts_at: window5h?.starts_at,
    managed_cpu_7d_starts_at: window7d?.starts_at,
    managed_cpu_5h_reset_at,
    managed_cpu_7d_reset_at,
    managed_cpu_5h_reset_in:
      managed_cpu_5h_reset_at != null
        ? formatDuration(
            Math.max(0, managed_cpu_5h_reset_at.getTime() - Date.now()),
          ) || undefined
        : undefined,
    managed_cpu_7d_reset_in:
      managed_cpu_7d_reset_at != null
        ? formatDuration(
            Math.max(0, managed_cpu_7d_reset_at.getTime() - Date.now()),
          ) || undefined
        : undefined,
    over_managed_cpu_5h:
      typeof opts.limit5h === "number" && Number.isFinite(opts.limit5h)
        ? managed_cpu_5h_seconds > opts.limit5h
        : undefined,
    over_managed_cpu_7d:
      typeof opts.limit7d === "number" && Number.isFinite(opts.limit7d)
        ? managed_cpu_7d_seconds > opts.limit7d
        : undefined,
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

export async function getRecentManagedCpuEventsForAccount(opts: {
  account_id: string;
  project_id?: string;
  limit?: number;
}): Promise<ManagedCpuEventSummary[]> {
  await ensureSchema();
  const limit =
    typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? Math.max(1, Math.min(50, Math.floor(opts.limit)))
      : 20;
  const params: Array<string | number> = [opts.account_id];
  const where: string[] = ["events.account_id = $1"];
  if (`${opts.project_id ?? ""}`.trim()) {
    params.push(`${opts.project_id}`.trim());
    where.push(`events.project_id = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await getPool("medium").query<RawManagedCpuEventRow>(
    `
      SELECT
        events.account_id,
        events.project_id,
        projects.title AS project_title,
        events.host_id,
        events.cpu_seconds,
        events.sample_started_at,
        events.sample_ended_at,
        events.source,
        events.metadata
      FROM ${TABLE} AS events
      LEFT JOIN projects ON projects.project_id = events.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY events.sample_ended_at DESC, events.id DESC
      LIMIT $${params.length}
    `,
    params,
  );
  return mapManagedCpuEventRows(rows);
}

export async function getManagedCpuAdminOverview(
  opts: {
    start?: string | Date;
    end?: string | Date;
    recent_event_limit?: number;
    top_account_limit?: number;
    top_project_limit?: number;
  } = {},
): Promise<ManagedCpuAdminOverview> {
  await ensureSchema();
  const query = normalizeOverviewQuery(opts);
  const whereSql =
    "events.sample_ended_at >= $1 AND events.sample_ended_at < $2";
  const params: Array<Date> = [query.startDate, query.endDate];

  const [
    totalResult,
    accountRowsResult,
    projectRowsResult,
    recentEventsResult,
  ] = await Promise.all([
    getPool("medium").query<{
      cpu_seconds: string | number;
    }>(
      `
          SELECT COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
          FROM ${TABLE} AS events
          WHERE ${whereSql}
        `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      first_name: string | null;
      last_name: string | null;
      cpu_seconds: string | number;
    }>(
      `
          SELECT
            events.account_id,
            accounts.email_address,
            accounts.first_name,
            accounts.last_name,
            COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
          FROM ${TABLE} AS events
          LEFT JOIN accounts ON accounts.account_id = events.account_id
          WHERE ${whereSql}
          GROUP BY
            events.account_id,
            accounts.email_address,
            accounts.first_name,
            accounts.last_name
          ORDER BY cpu_seconds DESC, events.account_id ASC
          LIMIT ${Math.max(1, Math.min(query.top_account_limit, 50))}
        `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      first_name: string | null;
      last_name: string | null;
      project_id: string | null;
      project_title: string | null;
      host_id: string | null;
      cpu_seconds: string | number;
    }>(
      `
          SELECT
            events.account_id,
            accounts.email_address,
            accounts.first_name,
            accounts.last_name,
            events.project_id,
            projects.title AS project_title,
            events.host_id,
            COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
          FROM ${TABLE} AS events
          LEFT JOIN accounts ON accounts.account_id = events.account_id
          LEFT JOIN projects ON projects.project_id = events.project_id
          WHERE ${whereSql}
          GROUP BY
            events.account_id,
            accounts.email_address,
            accounts.first_name,
            accounts.last_name,
            events.project_id,
            projects.title,
            events.host_id
          ORDER BY cpu_seconds DESC, projects.title ASC NULLS LAST, events.project_id ASC NULLS LAST
          LIMIT ${Math.max(1, Math.min(query.top_project_limit, 50))}
        `,
      params,
    ),
    getPool("medium").query<RawManagedCpuEventRow>(
      `
          SELECT
            events.account_id,
            events.project_id,
            projects.title AS project_title,
            events.host_id,
            events.cpu_seconds,
            events.sample_started_at,
            events.sample_ended_at,
            events.source,
            events.metadata
          FROM ${TABLE} AS events
          LEFT JOIN projects ON projects.project_id = events.project_id
          WHERE ${whereSql}
          ORDER BY events.sample_ended_at DESC, events.id DESC
          LIMIT ${Math.max(1, Math.min(query.recent_event_limit, 100))}
        `,
      params,
    ),
  ]);

  const top_accounts: ManagedCpuAccountSummary[] = accountRowsResult.rows.map(
    (row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      cpu_seconds: normalizeCpuSeconds(row.cpu_seconds),
    }),
  );

  const top_projects: ManagedCpuAdminProjectSummary[] =
    projectRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      project_id: row.project_id ?? null,
      project_title: row.project_title ?? null,
      host_id: row.host_id ?? null,
      cpu_seconds: normalizeCpuSeconds(row.cpu_seconds),
    }));
  const activeAnnotations = await listActiveAbuseReviewAnnotations({
    account_ids: [
      ...top_accounts.map((account) => account.account_id),
      ...top_projects.map((project) => project.account_id),
    ],
    project_ids: top_projects.map((project) => project.project_id),
    categories: ["cpu", "general"],
  });

  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    total_cpu_seconds: normalizeCpuSeconds(totalResult.rows[0]?.cpu_seconds),
    top_accounts: attachActiveAnnotationsToAccounts(
      top_accounts,
      activeAnnotations,
    ),
    top_projects: attachActiveAnnotationsToProjects(
      top_projects,
      activeAnnotations,
    ),
    recent_events: mapManagedCpuEventRows(recentEventsResult.rows),
  };
}

export async function getManagedCpuAdminHistory(opts: {
  account_id?: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedCpuHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): Promise<ManagedCpuAdminHistory> {
  await ensureSchema();
  const query = normalizeHistoryQuery(opts);
  const where: string[] = [
    "events.sample_ended_at >= $1",
    "events.sample_ended_at < $2",
  ];
  const params: Array<Date | string> = [query.startDate, query.endDate];
  if (query.account_id) {
    params.push(query.account_id);
    where.push(`events.account_id = $${params.length}`);
  }
  if (query.project_id) {
    params.push(query.project_id);
    where.push(`events.project_id = $${params.length}`);
  }
  const whereSql = where.join(" AND ");
  const bucketExpr = getBucketSql(query.bucket);

  const [
    totalResult,
    bucketRowsResult,
    accountRowsResult,
    projectRowsResult,
    recentEventsResult,
  ] = await Promise.all([
    getPool("medium").query<{ cpu_seconds: string | number }>(
      `
        SELECT COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
        FROM ${TABLE} AS events
        WHERE ${whereSql}
      `,
      params,
    ),
    getPool("medium").query<{
      bucket_start: Date | string;
      cpu_seconds: string | number;
    }>(
      `
        SELECT
          ${bucketExpr} AS bucket_start,
          COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
        FROM ${TABLE} AS events
        WHERE ${whereSql}
        GROUP BY bucket_start
        ORDER BY bucket_start ASC
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      first_name: string | null;
      last_name: string | null;
      cpu_seconds: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.first_name,
          accounts.last_name,
          COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
        FROM ${TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.first_name,
          accounts.last_name
        ORDER BY cpu_seconds DESC, events.account_id ASC
        LIMIT ${Math.max(1, Math.min(query.top_account_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<{
      account_id: string;
      email_address: string | null;
      first_name: string | null;
      last_name: string | null;
      project_id: string | null;
      project_title: string | null;
      host_id: string | null;
      cpu_seconds: string | number;
    }>(
      `
        SELECT
          events.account_id,
          accounts.email_address,
          accounts.first_name,
          accounts.last_name,
          events.project_id,
          projects.title AS project_title,
          events.host_id,
          COALESCE(SUM(events.cpu_seconds), 0) AS cpu_seconds
        FROM ${TABLE} AS events
        LEFT JOIN accounts ON accounts.account_id = events.account_id
        LEFT JOIN projects ON projects.project_id = events.project_id
        WHERE ${whereSql}
        GROUP BY
          events.account_id,
          accounts.email_address,
          accounts.first_name,
          accounts.last_name,
          events.project_id,
          projects.title,
          events.host_id
        ORDER BY cpu_seconds DESC, projects.title ASC NULLS LAST, events.project_id ASC NULLS LAST
        LIMIT ${Math.max(1, Math.min(query.top_project_limit, 50))}
      `,
      params,
    ),
    getPool("medium").query<RawManagedCpuEventRow>(
      `
        SELECT
          events.account_id,
          events.project_id,
          projects.title AS project_title,
          events.host_id,
          events.cpu_seconds,
          events.sample_started_at,
          events.sample_ended_at,
          events.source,
          events.metadata
        FROM ${TABLE} AS events
        LEFT JOIN projects ON projects.project_id = events.project_id
        WHERE ${whereSql}
        ORDER BY events.sample_ended_at DESC, events.id DESC
        LIMIT ${Math.max(1, Math.min(query.recent_event_limit, 100))}
      `,
      params,
    ),
  ]);

  const bucketData = new Map<string, ManagedCpuHistoryPoint>();
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
    point.cpu_seconds += normalizeCpuSeconds(row.cpu_seconds);
  }
  const top_accounts: ManagedCpuAccountSummary[] = accountRowsResult.rows.map(
    (row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      cpu_seconds: normalizeCpuSeconds(row.cpu_seconds),
    }),
  );
  const top_projects: ManagedCpuAdminProjectSummary[] =
    projectRowsResult.rows.map((row) => ({
      account_id: row.account_id,
      email_address: row.email_address ?? null,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      project_id: row.project_id ?? null,
      project_title: row.project_title ?? null,
      host_id: row.host_id ?? null,
      cpu_seconds: normalizeCpuSeconds(row.cpu_seconds),
    }));
  const activeAnnotations = await listActiveAbuseReviewAnnotations({
    account_ids: [
      ...top_accounts.map((account) => account.account_id),
      ...top_projects.map((project) => project.account_id),
    ],
    project_ids: top_projects.map((project) => project.project_id),
    categories: ["cpu", "general"],
  });

  return {
    start: query.startDate.toISOString(),
    end: query.endDate.toISOString(),
    bucket: query.bucket,
    total_cpu_seconds: normalizeCpuSeconds(totalResult.rows[0]?.cpu_seconds),
    points: [...bucketData.values()],
    top_accounts: attachActiveAnnotationsToAccounts(
      top_accounts,
      activeAnnotations,
    ),
    top_projects: attachActiveAnnotationsToProjects(
      top_projects,
      activeAnnotations,
    ),
    recent_events: mapManagedCpuEventRows(recentEventsResult.rows),
  };
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

function attachActiveAnnotationsToAccounts(
  accounts: ManagedCpuAccountSummary[],
  annotations: AbuseReviewAnnotation[],
): ManagedCpuAccountSummary[] {
  return accounts.map((account) => ({
    ...account,
    active_abuse_annotations: activeAnnotationsFor({
      annotations,
      account_id: account.account_id,
    }),
  }));
}

function attachActiveAnnotationsToProjects(
  projects: ManagedCpuAdminProjectSummary[],
  annotations: AbuseReviewAnnotation[],
): ManagedCpuAdminProjectSummary[] {
  return projects.map((project) => ({
    ...project,
    active_abuse_annotations: activeAnnotationsFor({
      annotations,
      account_id: project.account_id,
      project_id: project.project_id,
    }),
  }));
}

type RawManagedCpuEventRow = {
  account_id?: string;
  project_id?: string | null;
  project_title?: string | null;
  host_id?: string | null;
  cpu_seconds: string | number;
  sample_started_at?: string | Date | null;
  sample_ended_at: string | Date;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
};

function mapManagedCpuEventRows(
  rows: RawManagedCpuEventRow[],
): ManagedCpuEventSummary[] {
  return rows.map((row) => ({
    account_id: row.account_id,
    project_id: row.project_id ?? null,
    project_title: row.project_title ?? null,
    host_id: row.host_id ?? null,
    cpu_seconds: normalizeCpuSeconds(row.cpu_seconds),
    sample_started_at: row.sample_started_at
      ? new Date(row.sample_started_at).toISOString()
      : null,
    sample_ended_at: new Date(row.sample_ended_at).toISOString(),
    source: row.source ?? null,
    metadata: row.metadata ?? null,
  }));
}

function parseOptionalTimestamp(value?: string | Date): Date | undefined {
  if (value == null || value === "") return;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw Error("invalid timestamp");
  }
  return date;
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
    throw Error("start must be before end");
  }
  if (endDate.getTime() - startDate.getTime() > MAX_HISTORY_WINDOW_MS) {
    throw Error("history window must be at most 31 days");
  }
  return { startDate, endDate };
}

function normalizeOverviewQuery({
  start,
  end,
  recent_event_limit,
  top_account_limit,
  top_project_limit,
}: {
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}) {
  const { startDate, endDate } = normalizeWindowBounds({ start, end });
  return {
    startDate,
    endDate,
    recent_event_limit:
      typeof recent_event_limit === "number" &&
      Number.isFinite(recent_event_limit)
        ? Math.floor(recent_event_limit)
        : 20,
    top_account_limit:
      typeof top_account_limit === "number" &&
      Number.isFinite(top_account_limit)
        ? Math.floor(top_account_limit)
        : 20,
    top_project_limit:
      typeof top_project_limit === "number" &&
      Number.isFinite(top_project_limit)
        ? Math.max(1, Math.min(50, Math.floor(top_project_limit)))
        : 20,
  };
}

function normalizeHistoryQuery(opts: {
  account_id?: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: ManagedCpuHistoryBucketSize;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}): {
  account_id?: string;
  project_id?: string;
  startDate: Date;
  endDate: Date;
  bucket: ManagedCpuHistoryBucketSize;
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
    throw Error("history query is too granular for the requested time range");
  }
  return {
    account_id: `${opts.account_id ?? ""}`.trim() || undefined,
    project_id: `${opts.project_id ?? ""}`.trim() || undefined,
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

function getBucketMs(bucket: ManagedCpuHistoryBucketSize): number {
  switch (bucket) {
    case "5m":
      return 5 * 60 * 1000;
    case "1h":
      return 60 * 60 * 1000;
    case "1d":
      return 24 * 60 * 60 * 1000;
  }
}

function getBucketSql(bucket: ManagedCpuHistoryBucketSize): string {
  switch (bucket) {
    case "5m":
      return "to_timestamp(floor(extract(epoch from events.sample_ended_at) / 300) * 300)";
    case "1h":
      return "to_timestamp(floor(extract(epoch from events.sample_ended_at) / 3600) * 3600)";
    case "1d":
      return "date_trunc('day', events.sample_ended_at)";
  }
}

function buildEmptyHistoryPoints({
  start,
  end,
  bucket,
}: {
  start: Date;
  end: Date;
  bucket: ManagedCpuHistoryBucketSize;
}): ManagedCpuHistoryPoint[] {
  const bucketMs = getBucketMs(bucket);
  const firstBucketStartMs = Math.floor(start.getTime() / bucketMs) * bucketMs;
  const points: ManagedCpuHistoryPoint[] = [];
  for (
    let currentStartMs = firstBucketStartMs;
    currentStartMs < end.getTime();
    currentStartMs += bucketMs
  ) {
    points.push({
      start: new Date(currentStartMs).toISOString(),
      end: new Date(
        Math.min(currentStartMs + bucketMs, end.getTime()),
      ).toISOString(),
      cpu_seconds: 0,
    });
  }
  return points;
}
