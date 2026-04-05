/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  AccountFeedEvent,
  AccountFeedProjectRow,
} from "@cocalc/conat/hub/api/account-feed";
import { isValidUUID } from "@cocalc/util/misc";
import type {
  ProjectOutboxEventRow,
  ProjectOutboxPayload,
} from "./project-events-outbox";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
const VISIBLE_GROUPS = new Set(["owner", "collaborator"]);

export interface DrainAccountProjectIndexProjectionResult {
  bay_id: string;
  dry_run: boolean;
  requested_limit: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  feed_events: AccountFeedEvent[];
  event_types: Record<string, number>;
}

export interface AccountProjectIndexProjectionBacklogStatus {
  bay_id: string;
  checked_at: string;
  unpublished_events: number;
  unpublished_event_types: Record<string, number>;
  oldest_unpublished_event_at: string | null;
  newest_unpublished_event_at: string | null;
  oldest_unpublished_event_age_ms: number | null;
  newest_unpublished_event_age_ms: number | null;
}

function normalizeBayId(raw?: string | null): string {
  const bay_id = `${raw ?? ""}`.trim();
  return bay_id || DEFAULT_SINGLE_BAY_ID;
}

function normalizeLimit(raw?: number): number {
  const limit = raw ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return limit;
}

function visibleAccountIdsFromUsers(
  users_summary: Record<string, any> | undefined,
): string[] {
  const account_ids: string[] = [];
  for (const [account_id, info] of Object.entries(users_summary ?? {})) {
    if (!isValidUUID(account_id)) continue;
    const group = `${info?.group ?? ""}`.trim();
    if (!VISIBLE_GROUPS.has(group)) continue;
    account_ids.push(account_id);
  }
  return account_ids;
}

function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(`${value}`);
  if (!Number.isFinite(date.getTime())) return null;
  return date;
}

function sortKeyForAccount(
  payload: ProjectOutboxPayload,
  account_id: string,
  fallback: Date,
): Date {
  return (
    parseDate(payload.last_activity_by_account?.[account_id]) ??
    parseDate(payload.last_edited_at) ??
    parseDate(payload.created_at) ??
    fallback
  );
}

function ageMs(now: Date, when: Date | null): number | null {
  if (when == null) return null;
  return Math.max(0, now.getTime() - when.getTime());
}

async function localHomeAccountIds(
  db: PoolClient,
  opts: { bay_id: string; account_ids: string[] },
): Promise<Set<string>> {
  if (opts.account_ids.length === 0) {
    return new Set<string>();
  }
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT account_id
       FROM accounts
      WHERE account_id = ANY($1::UUID[])
        AND (deleted IS NULL OR deleted = FALSE)
        AND COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) = $2::TEXT`,
    [opts.account_ids, opts.bay_id],
  );
  return new Set(rows.map((row) => row.account_id));
}

async function existingLastOpenedAt(
  db: PoolClient,
  project_id: string,
): Promise<Map<string, Date | null>> {
  const { rows } = await db.query<{
    account_id: string;
    last_opened_at: Date | null;
  }>(
    `SELECT account_id, last_opened_at
       FROM account_project_index
      WHERE project_id = $1`,
    [project_id],
  );
  return new Map(
    rows.map((row) => [row.account_id, row.last_opened_at ?? null]),
  );
}

export async function computeAccountProjectFeedEvents(opts: {
  db: PoolClient;
  bay_id: string;
  payload: ProjectOutboxPayload;
  previous_local_account_ids?: string[];
}): Promise<AccountFeedEvent[]> {
  const { db, bay_id, payload } = opts;
  const previousLocalAccountIds =
    opts.previous_local_account_ids ??
    Array.from((await existingLastOpenedAt(db, payload.project_id)).keys());
  const visibleAccountIds = visibleAccountIdsFromUsers(payload.users_summary);
  const localAccounts = await localHomeAccountIds(db, {
    bay_id,
    account_ids: visibleAccountIds,
  });
  const currentLocalAccountIds = visibleAccountIds.filter((account_id) =>
    localAccounts.has(account_id),
  );
  const feed_events: AccountFeedEvent[] = [];
  const removedAccountIds = previousLocalAccountIds.filter(
    (account_id) => !currentLocalAccountIds.includes(account_id),
  );
  for (const account_id of removedAccountIds) {
    feed_events.push({
      type: "project.remove",
      ts: Date.now(),
      account_id,
      project_id: payload.project_id,
      reason: "membership_removed",
    });
  }
  for (const account_id of currentLocalAccountIds) {
    feed_events.push({
      type: "project.upsert",
      ts: Date.now(),
      account_id,
      project: projectRowForFeed({ payload, account_id }),
    });
  }
  return feed_events;
}

function projectRowForFeed(opts: {
  payload: ProjectOutboxPayload;
  account_id: string;
}): AccountFeedProjectRow {
  const { payload } = opts;
  return {
    project_id: payload.project_id,
    title: payload.title ?? "",
    description: payload.description ?? "",
    name: payload.name ?? null,
    avatar_image_tiny: payload.avatar_image_tiny ?? null,
    color: payload.color ?? null,
    host_id: payload.host_id ?? null,
    owning_bay_id: normalizeBayId(payload.owning_bay_id),
    users: payload.users_summary ?? {},
    state: payload.state_summary ?? {},
    last_active: payload.last_activity_by_account ?? {},
    last_edited: payload.last_edited_at ?? null,
    deleted: !!payload.deleted,
  };
}

async function applyProjectEventToAccountProjectIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: ProjectOutboxEventRow;
}): Promise<{
  inserted_rows: number;
  deleted_rows: number;
  feed_events: AccountFeedEvent[];
}> {
  const { db, bay_id, event } = opts;
  const payload = event.payload_json;
  const lastOpenedByAccount = await existingLastOpenedAt(
    db,
    payload.project_id,
  );
  const deleted = await db.query(
    `DELETE FROM account_project_index
      WHERE project_id = $1`,
    [payload.project_id],
  );
  const feed_events = await computeAccountProjectFeedEvents({
    db,
    bay_id,
    payload,
    previous_local_account_ids: Array.from(lastOpenedByAccount.keys()),
  });
  const currentLocalAccountIds = feed_events
    .filter(
      (event): event is Extract<AccountFeedEvent, { type: "project.upsert" }> =>
        event.type === "project.upsert",
    )
    .map((event) => event.account_id);
  if (payload.deleted) {
    return {
      inserted_rows: 0,
      deleted_rows: deleted.rowCount ?? 0,
      feed_events,
    };
  }

  let inserted_rows = 0;
  for (const account_id of currentLocalAccountIds) {
    const last_activity_at =
      parseDate(payload.last_activity_by_account?.[account_id]) ?? null;
    await db.query(
      `INSERT INTO account_project_index
         (account_id, project_id, owning_bay_id, host_id, title, description,
          users_summary, state_summary, last_activity_at, last_opened_at,
          is_hidden, sort_key, updated_at)
       VALUES
         ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::JSONB, $9, $10, $11, $12, NOW())`,
      [
        account_id,
        payload.project_id,
        normalizeBayId(payload.owning_bay_id),
        payload.host_id,
        payload.title,
        payload.description,
        JSON.stringify(payload.users_summary ?? {}),
        JSON.stringify(payload.state_summary ?? {}),
        last_activity_at,
        lastOpenedByAccount.get(account_id) ?? null,
        !!payload.users_summary?.[account_id]?.hide,
        sortKeyForAccount(payload, account_id, event.created_at),
      ],
    );
    inserted_rows += 1;
  }
  return {
    inserted_rows,
    deleted_rows: deleted.rowCount ?? 0,
    feed_events,
  };
}

export async function getAccountProjectIndexProjectionBacklogStatus(opts?: {
  bay_id?: string;
  now?: Date;
}): Promise<AccountProjectIndexProjectionBacklogStatus> {
  const bay_id = normalizeBayId(opts?.bay_id);
  const now = opts?.now ?? new Date();
  const { rows } = await getPool().query<{
    event_type: string;
    count: number | string;
    oldest_unpublished_event_at: Date | null;
    newest_unpublished_event_at: Date | null;
  }>(
    `SELECT
       event_type,
       COUNT(*)::INT AS count,
       MIN(created_at) AS oldest_unpublished_event_at,
       MAX(created_at) AS newest_unpublished_event_at
     FROM project_events_outbox
     WHERE COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1::TEXT) = $1::TEXT
       AND published_at IS NULL
     GROUP BY event_type
     ORDER BY event_type ASC`,
    [bay_id],
  );

  let unpublished_events = 0;
  let oldest_unpublished_event_at: Date | null = null;
  let newest_unpublished_event_at: Date | null = null;
  const unpublished_event_types: Record<string, number> = {};
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    unpublished_events += count;
    unpublished_event_types[row.event_type] = count;
    if (
      row.oldest_unpublished_event_at != null &&
      (oldest_unpublished_event_at == null ||
        row.oldest_unpublished_event_at < oldest_unpublished_event_at)
    ) {
      oldest_unpublished_event_at = row.oldest_unpublished_event_at;
    }
    if (
      row.newest_unpublished_event_at != null &&
      (newest_unpublished_event_at == null ||
        row.newest_unpublished_event_at > newest_unpublished_event_at)
    ) {
      newest_unpublished_event_at = row.newest_unpublished_event_at;
    }
  }

  return {
    bay_id,
    checked_at: now.toISOString(),
    unpublished_events,
    unpublished_event_types,
    oldest_unpublished_event_at:
      oldest_unpublished_event_at?.toISOString() ?? null,
    newest_unpublished_event_at:
      newest_unpublished_event_at?.toISOString() ?? null,
    oldest_unpublished_event_age_ms: ageMs(now, oldest_unpublished_event_at),
    newest_unpublished_event_age_ms: ageMs(now, newest_unpublished_event_at),
  };
}

export async function drainAccountProjectIndexProjection(opts?: {
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<DrainAccountProjectIndexProjectionResult> {
  const bay_id = normalizeBayId(opts?.bay_id);
  const limit = normalizeLimit(opts?.limit);
  const dry_run = opts?.dry_run ?? true;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<ProjectOutboxEventRow>(
      `SELECT
         event_id,
         project_id,
         owning_bay_id,
         event_type,
         payload_json,
         created_at,
         published_at
       FROM project_events_outbox
      WHERE COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1::TEXT) = $1::TEXT
        AND published_at IS NULL
      ORDER BY created_at ASC, event_id ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
      [bay_id, limit],
    );

    const result: DrainAccountProjectIndexProjectionResult = {
      bay_id,
      dry_run,
      requested_limit: limit,
      scanned_events: rows.length,
      applied_events: 0,
      inserted_rows: 0,
      deleted_rows: 0,
      feed_events: [],
      event_types: {},
    };

    for (const event of rows) {
      const applied = await applyProjectEventToAccountProjectIndex({
        db: client,
        bay_id,
        event,
      });
      result.applied_events += 1;
      result.inserted_rows += applied.inserted_rows;
      result.deleted_rows += applied.deleted_rows;
      result.feed_events.push(...applied.feed_events);
      result.event_types[event.event_type] =
        (result.event_types[event.event_type] ?? 0) + 1;
      await client.query(
        `UPDATE project_events_outbox
            SET published_at = NOW()
          WHERE event_id = $1`,
        [event.event_id],
      );
    }

    await client.query(dry_run ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
