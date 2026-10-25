/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Who viewed a public directory share.

Operators and a share's owners need to know who viewed a share, and an
institution asked for aggregate reports (views by country, say). So when an
account reads a share (authorizeRead, which the project host calls before
serving the share's files), this records that the account read something in
that share on that UTC day: one row per (share, account, day), never which
path and not how often. Rows are deleted after RETENTION_MONTHS.

The row is written on the bay that owns the share, at most once per
(share, account, day) per hub process thanks to an in-memory cache, and
without waiting for it: a failed or slow write never blocks or fails a read.

Reports:
- getViews: for the share's owners and collaborators, counts per day and of
  distinct viewers, split by role. Never who the other viewers were.
- getViewAggregates: for admins, aggregates only (per day, per country),
  with counts made up of fewer than MIN_AGGREGATE_COUNT accounts suppressed.
*/

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import type {
  GetPublicDirectoryShareViewAggregatesOptions,
  GetPublicDirectoryShareViewAggregatesResponse,
  GetPublicDirectoryShareViewsOptions,
  GetPublicDirectoryShareViewsResponse,
  PublicDirectoryShareViewAggregate,
  PublicDirectoryShareViewerRole,
} from "@cocalc/conat/hub/api/public-directory-shares";

const logger = getLogger("server:public-directory-shares:views");

export const RETENTION_MONTHS = 13;
export const MIN_AGGREGATE_COUNT = 5;
const DEFAULT_REPORT_DAYS = 30;
// a little over RETENTION_MONTHS
const MAX_REPORT_DAYS = 400;
// cap on the "already recorded today" cache; it is cleared when it is full
// (the database ignores the duplicates) and every UTC day
const MAX_RECORDED_CACHE = 100_000;
const VIEWER_ROLES: PublicDirectoryShareViewerRole[] = [
  "owner",
  "collaborator",
  "other",
];

let schemaReady: Promise<void> | undefined;

export async function ensurePublicShareViewsSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public_share_views (
        share_id UUID NOT NULL,
        account_id UUID NOT NULL,
        day DATE NOT NULL,
        project_id UUID NOT NULL,
        viewer_role VARCHAR(16) NOT NULL,
        country CHAR(2),
        first_at TIMESTAMP NOT NULL DEFAULT NOW(),
        -- (day before account_id, so a share's report reads only its days)
        PRIMARY KEY (share_id, day, account_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_share_views_day_idx
        ON public_share_views (day)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_share_views_project_day_idx
        ON public_share_views (project_id, day)
    `);
  })();
  try {
    await schemaReady;
  } catch (err) {
    schemaReady = undefined;
    throw err;
  }
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

export function viewerRole(
  project_users: Record<string, { group?: string } | null> | null | undefined,
  account_id: string,
): PublicDirectoryShareViewerRole {
  const group = project_users?.[account_id]?.group;
  return group === "owner" || group === "collaborator" ? group : "other";
}

// ISO 3166-1 alpha-2 only; Cloudflare's XX (unknown) and T1 (Tor) are not
// countries.
export function normalizeCountry(country?: string | null): string | null {
  const value = `${country ?? ""}`.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(value) && value !== "XX" ? value : null;
}

async function lookUpViewerRole(
  project_id: string,
  account_id: string,
): Promise<PublicDirectoryShareViewerRole> {
  const { rows } = await getPool().query<{ group: string | null }>(
    "SELECT users -> $2::text ->> 'group' AS \"group\" FROM projects WHERE project_id=$1",
    [project_id, account_id],
  );
  return viewerRole(
    { [account_id]: { group: rows[0]?.group ?? undefined } },
    account_id,
  );
}

let recordedDay = "";
const recorded = new Set<string>();

export interface RecordShareViewOptions {
  share_id: string;
  project_id: string;
  account_id: string;
  // the project's users, when the caller has them; otherwise looked up
  project_users?: Record<string, { group?: string } | null> | null;
  country?: string | null;
  now?: Date;
}

// Records the view and resolves when it is written, or right away when this
// process already recorded it today. Rejects if the write fails.
export async function recordShareViewNow({
  share_id,
  project_id,
  account_id,
  project_users,
  country,
  now = new Date(),
}: RecordShareViewOptions): Promise<void> {
  const day = utcDay(now);
  if (day !== recordedDay) {
    recorded.clear();
    recordedDay = day;
  }
  const key = `${share_id}/${account_id}`;
  if (recorded.has(key)) return;
  if (recorded.size >= MAX_RECORDED_CACHE) recorded.clear();
  recorded.add(key);
  try {
    await ensurePublicShareViewsSchema();
    const role =
      project_users !== undefined
        ? viewerRole(project_users, account_id)
        : await lookUpViewerRole(project_id, account_id);
    await getPool().query(
      `
        INSERT INTO public_share_views
          (share_id, account_id, day, project_id, viewer_role, country, first_at)
        VALUES ($1, $2, $3::date, $4, $5, $6, $7)
        ON CONFLICT (share_id, day, account_id) DO NOTHING
      `,
      [
        share_id,
        account_id,
        day,
        project_id,
        role,
        normalizeCountry(country),
        now,
      ],
    );
  } catch (err) {
    // so a later read tries again
    if (recordedDay === day) recorded.delete(key);
    throw err;
  }
}

// Fire and forget: never blocks or fails the read that triggered it.
export function recordShareView(opts: RecordShareViewOptions): void {
  recordShareViewNow(opts).catch((err) => {
    logger.warn("recording a public share view failed", {
      share_id: opts.share_id,
      err: `${err}`,
    });
  });
}

function normalizeDays(days?: number): number {
  if (days == null) return DEFAULT_REPORT_DAYS;
  const value = Math.floor(Number(days));
  if (!Number.isFinite(value) || value < 1) {
    throw Error("days must be a positive integer");
  }
  return Math.min(value, MAX_REPORT_DAYS);
}

function count(value: unknown): number {
  return Number(value ?? 0);
}

export async function getViews({
  account_id,
  project_id,
  share_id,
  days,
  now = new Date(),
}: GetPublicDirectoryShareViewsOptions & {
  now?: Date;
}): Promise<GetPublicDirectoryShareViewsResponse> {
  if (!account_id) throw Error("user must be signed in");
  if (!isValidUUID(project_id)) throw Error("invalid project_id");
  if (!isValidUUID(share_id)) throw Error("invalid public directory share id");
  const today = utcDay(now);
  const since = addDays(today, 1 - normalizeDays(days));
  await ensurePublicShareViewsSchema();
  const pool = getPool();
  const { rows: shares } = await pool.query<{ allowed: boolean }>(
    `
      SELECT (COALESCE(projects.users -> $3::text ->> 'group', '')
                IN ('owner', 'collaborator')) AS allowed
      FROM public_project_paths pps
      LEFT JOIN projects ON projects.project_id=pps.project_id
      WHERE pps.id=$1 AND pps.project_id=$2
      LIMIT 1
    `,
    [share_id, project_id, account_id],
  );
  if (!shares[0] || (!shares[0].allowed && !(await isAdmin(account_id)))) {
    throw Error("public directory share not found");
  }
  const roleCounts = (expr: string) =>
    VIEWER_ROLES.map(
      (role) => `${expr} FILTER (WHERE viewer_role='${role}') AS ${role}`,
    ).join(", ");
  const { rows: byDay } = await pool.query(
    `
      SELECT to_char(day, 'YYYY-MM-DD') AS day, COUNT(*) AS viewers,
             ${roleCounts("COUNT(*)")}
      FROM public_share_views
      WHERE share_id=$1 AND day >= $2::date AND day <= $3::date
      GROUP BY day
      ORDER BY day
    `,
    [share_id, since, today],
  );
  const { rows: distinct } = await pool.query(
    `
      SELECT COUNT(DISTINCT account_id) AS viewers,
             ${roleCounts("COUNT(DISTINCT account_id)")}
      FROM public_share_views
      WHERE share_id=$1 AND day >= $2::date AND day <= $3::date
    `,
    [share_id, since, today],
  );
  const counts = (row: any) => ({
    viewers: count(row?.viewers),
    owner: count(row?.owner),
    collaborator: count(row?.collaborator),
    other: count(row?.other),
  });
  return {
    project_id,
    share_id,
    since,
    by_day: byDay.map((row) => ({ day: row.day, ...counts(row) })),
    distinct_viewers: counts(distinct[0]),
  };
}

// The aggregate, or null when fewer than MIN_AGGREGATE_COUNT accounts make
// it up.
export function suppress(row: {
  viewer_days?: unknown;
  distinct_viewers?: unknown;
}): PublicDirectoryShareViewAggregate | null {
  const distinct_viewers = count(row.distinct_viewers);
  if (distinct_viewers < MIN_AGGREGATE_COUNT) return null;
  return { viewer_days: count(row.viewer_days), distinct_viewers };
}

// Rows whose aggregate is suppressed are left out, key and all.
function shown<K extends string>(
  rows: any[],
  key: K,
): (PublicDirectoryShareViewAggregate & Record<K, any>)[] {
  return rows.flatMap((row) => {
    const aggregate = suppress(row);
    return aggregate == null
      ? []
      : [{ [key]: row[key] ?? null, ...aggregate } as any];
  });
}

export async function getViewAggregates({
  account_id,
  project_id,
  share_id,
  viewer_role,
  days,
  now = new Date(),
}: GetPublicDirectoryShareViewAggregatesOptions & {
  now?: Date;
}): Promise<GetPublicDirectoryShareViewAggregatesResponse> {
  if (!account_id) throw Error("user must be signed in");
  if (!(await isAdmin(account_id))) throw Error("must be an admin");
  if (project_id != null && !isValidUUID(project_id)) {
    throw Error("invalid project_id");
  }
  if (share_id != null && !isValidUUID(share_id)) {
    throw Error("invalid public directory share id");
  }
  if (share_id != null) {
    // so the caller tries the bay that stores it (server/conat/api)
    const { rows } = await getPool().query(
      "SELECT 1 FROM public_project_paths WHERE id=$1 AND project_id=$2",
      [share_id, project_id],
    );
    if (rows.length === 0) throw Error("public directory share not found");
  } else if (project_id != null) {
    throw Error("project_id is only for finding share_id's bay");
  }
  if (viewer_role != null && !VIEWER_ROLES.includes(viewer_role)) {
    throw Error("invalid viewer_role");
  }
  const today = utcDay(now);
  const since = addDays(today, 1 - normalizeDays(days));
  await ensurePublicShareViewsSchema();
  const params: unknown[] = [since, today];
  const clauses = ["day >= $1::date", "day <= $2::date"];
  for (const [column, value] of [
    ["share_id", share_id],
    ["viewer_role", viewer_role],
  ] as const) {
    if (value != null) {
      params.push(value);
      clauses.push(`${column}=$${params.length}`);
    }
  }
  const where = clauses.join(" AND ");
  const aggregate = `COUNT(*) AS viewer_days,
    COUNT(DISTINCT account_id) AS distinct_viewers`;
  const pool = getPool();
  const [totals, byDay, byCountry] = await Promise.all([
    pool.query(`SELECT ${aggregate} FROM public_share_views WHERE ${where}`, [
      ...params,
    ]),
    pool.query(
      `
        SELECT to_char(day, 'YYYY-MM-DD') AS day, ${aggregate}
        FROM public_share_views WHERE ${where}
        GROUP BY day ORDER BY day
      `,
      [...params],
    ),
    pool.query(
      `
        SELECT country, ${aggregate}
        FROM public_share_views WHERE ${where}
        GROUP BY country ORDER BY country NULLS LAST
      `,
      [...params],
    ),
  ]);
  return {
    since,
    min_count: MIN_AGGREGATE_COUNT,
    totals: suppress(totals.rows[0] ?? {}),
    by_day: shown(byDay.rows, "day"),
    by_country: shown(byCountry.rows, "country"),
  };
}

export async function pruneShareViews({
  now = new Date(),
  retentionMonths = RETENTION_MONTHS,
}: { now?: Date; retentionMonths?: number } = {}): Promise<number> {
  await ensurePublicShareViewsSchema();
  // (date minus months clamps to the month's end: 2026-03-31 minus 13 months
  // is 2025-02-28)
  const { rowCount } = await getPool().query(
    `DELETE FROM public_share_views
      WHERE day < ($1::date - ($2::int * INTERVAL '1 month'))::date`,
    [utcDay(now), retentionMonths],
  );
  return rowCount ?? 0;
}

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let pruneStarted = false;

export function startShareViewsRetentionMaintenance(): void {
  if (pruneStarted) return;
  pruneStarted = true;
  const run = async () => {
    try {
      const deleted = await pruneShareViews();
      if (deleted > 0) {
        logger.info("deleted expired public share views", { deleted });
      }
    } catch (err) {
      logger.warn("public share views retention failed", { err: `${err}` });
    }
  };
  void run();
  setInterval(run, PRUNE_INTERVAL_MS).unref?.();
}

export const __test__ = {
  resetRecordedCache: () => {
    recorded.clear();
    recordedDay = "";
  },
};
