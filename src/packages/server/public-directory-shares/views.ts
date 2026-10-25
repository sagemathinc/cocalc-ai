/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Who viewed a public directory share.

Operators and a share's owners need to know who viewed a share, and an
institution asked for aggregate reports. So when an
account reads a share (authorizeRead, which the project host calls before
serving the share's files), this records that the account read something in
that share on that UTC day: one row per (share, account, day), never which
path and not how often. Rows are deleted after RETENTION_MONTHS.

Where the viewer is, only as coarsely as one of the six regions of
R2_REGIONS: from the viewer's latest browser location on this bay
(account_presence_locations, kept while the active user map is enabled),
else unknown. Never the country or city.

The row is written on the bay that owns the share, at most once per
(share, account, day) per hub process thanks to an in-memory cache, and
without waiting for it: a failed or slow write never blocks or fails a read.

Reports:
- getViews: for the share's owners and collaborators, counts per day and of
  distinct viewers, split by role. Never who the other viewers were, nor
  where: they choose the range, so comparing two ranges could tell one
  viewer's region.
- getViewAggregates: for admins, aggregates over one dimension (days or
  regions), leaving out buckets of fewer than MIN_AGGREGATE_COUNT accounts,
  and the totals too when any bucket is left out, so one report holds
  nothing to subtract. Comparing several reports can still recover a
  suppressed count, which is why a set of reports needs review before it is
  handed on.
*/

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { is_valid_uuid_string as isValidUUID } from "@cocalc/util/misc";
import { mapCountryRegionToR2Region } from "@cocalc/util/consts/r2-regions";
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
        region VARCHAR(8),
        first_at TIMESTAMP NOT NULL DEFAULT NOW(),
        -- (day before account_id, so a share's report reads only its days)
        PRIMARY KEY (share_id, day, account_id)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_share_views_day_idx
        ON public_share_views (day)
    `);
    // deleting an account's views, and those of deleted accounts
    await pool.query(`
      CREATE INDEX IF NOT EXISTS public_share_views_account_idx
        ON public_share_views (account_id)
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
  group?: string | null,
): PublicDirectoryShareViewerRole {
  return group === "owner" || group === "collaborator" ? group : "other";
}

// The viewer's region, from the latest browser location this bay has for
// the account; null when there is none (e.g. the active user map is off, or
// the account's browser connects to another bay).
export async function viewerRegion(account_id: string): Promise<string | null> {
  const { rows } = await getPool().query<{
    country_code: string | null;
    region_code: string | null;
  }>(
    `SELECT country_code, region_code FROM account_presence_locations
      WHERE account_id=$1 AND expire > NOW()`,
    [account_id],
  );
  const country = `${rows[0]?.country_code ?? ""}`.trim().toUpperCase();
  // Cloudflare: XX unknown, T1 Tor
  if (!/^[A-Z]{2}$/.test(country) || country === "XX" || country === "T1") {
    return null;
  }
  return mapCountryRegionToR2Region(country, rows[0]?.region_code);
}

// The account's group in the project, as the project's owning bay has it: a
// share can be stored off its project's bay (a legacy placement), where the
// local projects row is not authoritative. (Imported here because
// project-remote-access imports the public share API.)
async function projectGroup(
  project_id: string,
  account_id: string,
): Promise<string | undefined> {
  const { resolveProjectReferenceForMemberAllowRemote } =
    await import("@cocalc/server/conat/project-remote-access");
  const reference = await resolveProjectReferenceForMemberAllowRemote({
    account_id,
    project_id,
  });
  return reference?.users?.[account_id]?.group;
}

let recordedDay = "";
const recorded = new Set<string>();

export interface RecordShareViewOptions {
  share_id: string;
  project_id: string;
  account_id: string;
  now?: Date;
}

// Records the view and resolves when it is written, or right away when this
// process already recorded it today. Rejects if the write fails.
export async function recordShareViewNow({
  share_id,
  project_id,
  account_id,
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
    const role = viewerRole(await projectGroup(project_id, account_id));
    const region = await viewerRegion(account_id);
    await getPool().query(
      `
        INSERT INTO public_share_views
          (share_id, account_id, day, project_id, viewer_role, region, first_at)
        VALUES ($1, $2, $3::date, $4, $5, $6, $7)
        ON CONFLICT (share_id, day, account_id) DO NOTHING
      `,
      [share_id, account_id, day, project_id, role, region, now],
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
  const { rows: shares } = await pool.query(
    "SELECT 1 FROM public_project_paths WHERE id=$1 AND project_id=$2",
    [share_id, project_id],
  );
  if (shares.length === 0) throw Error("public directory share not found");
  const role = viewerRole(
    await projectGroup(project_id, account_id).catch(() => undefined),
  );
  if (role === "other" && !(await isAdmin(account_id))) {
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
  // Each distinct viewer once, with the role of their latest view in the
  // range, so the split adds up to the total.
  const latest = `
    SELECT DISTINCT ON (account_id) account_id, viewer_role
    FROM public_share_views
    WHERE share_id=$1 AND day >= $2::date AND day <= $3::date
    ORDER BY account_id, day DESC
  `;
  const { rows: distinct } = await pool.query(
    `SELECT COUNT(*) AS viewers, ${roleCounts("COUNT(*)")}
       FROM (${latest}) latest`,
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

export async function getViewAggregates({
  account_id,
  project_id,
  share_id,
  viewer_role,
  days,
  group_by = "day",
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
  if (group_by !== "day" && group_by !== "region") {
    throw Error("invalid group_by");
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
  const key = group_by === "day" ? "to_char(day, 'YYYY-MM-DD')" : "region";
  // One statement, so the totals and the buckets come from one snapshot: a
  // view written between two queries could make the totals give a left-out
  // bucket away.
  const { rows } = await getPool().query(
    `
      SELECT key, GROUPING(key) = 1 AS is_total, ${aggregate}
      FROM (
        SELECT ${key} AS key, account_id
        FROM public_share_views WHERE ${where}
      ) v
      GROUP BY GROUPING SETS ((key), ())
      ORDER BY is_total, key NULLS LAST
    `,
    params,
  );
  const grouped = rows.filter((row) => !row.is_total);
  const total = rows.find((row) => row.is_total) ?? {};
  // A left-out bucket leaves out the totals as well: totals minus the
  // listed buckets would give the left-out ones away.
  const buckets = grouped.flatMap((row) => {
    const aggregate = suppress(row);
    return aggregate == null ? [] : [{ key: row.key ?? null, ...aggregate }];
  });
  const complete = buckets.length === grouped.length;
  return {
    since,
    until: today,
    min_count: MIN_AGGREGATE_COUNT,
    group_by,
    totals: complete ? suppress(total) : null,
    buckets,
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
  // and any left by an account deleted on this bay
  const { rowCount: deleted } = await getPool().query(
    `DELETE FROM public_share_views v USING accounts a
      WHERE a.account_id=v.account_id AND a.deleted IS TRUE`,
  );
  return (rowCount ?? 0) + (deleted ?? 0);
}

// When an account is deleted, on its home bay. Views of shares stored on
// other bays are deleted with them after RETENTION_MONTHS.
export async function deleteShareViewsForAccount(
  account_id: string,
): Promise<number> {
  await ensurePublicShareViewsSchema();
  const { rowCount } = await getPool().query(
    "DELETE FROM public_share_views WHERE account_id=$1",
    [account_id],
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
