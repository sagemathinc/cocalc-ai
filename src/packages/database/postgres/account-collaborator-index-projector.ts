/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  AccountFeedCollaboratorRow,
  AccountFeedEvent,
} from "@cocalc/conat/hub/api/account-feed";
import { isValidUUID } from "@cocalc/util/misc";
import { replaceAccountCollaboratorIndexRows } from "./account-collaborator-index";
import type {
  ProjectOutboxEventRow,
  ProjectOutboxEventType,
  ProjectOutboxPayload,
} from "./project-events-outbox";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
const RELEVANT_EVENT_TYPES: ProjectOutboxEventType[] = [
  "project.created",
  "project.membership_changed",
  "project.deleted",
];

export interface DrainAccountCollaboratorIndexProjectionResult {
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

export interface AccountCollaboratorIndexProjectionBacklogStatus {
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

function ageMs(now: Date, when: Date | null): number | null {
  if (when == null) return null;
  return Math.max(0, now.getTime() - when.getTime());
}

function participantAccountIds(payload: ProjectOutboxPayload): string[] {
  return Object.keys(payload.users_summary ?? {}).filter((account_id) =>
    isValidUUID(account_id),
  );
}

async function previousParticipantAccountIds(
  db: PoolClient,
  event: ProjectOutboxEventRow,
): Promise<string[]> {
  const { rows } = await db.query<{
    payload_json: ProjectOutboxPayload | null;
  }>(
    `SELECT payload_json
       FROM project_events_outbox
      WHERE project_id = $1
        AND event_id <> $2
        AND (created_at < $3 OR (created_at = $3 AND event_id::TEXT < $2::TEXT))
      ORDER BY created_at DESC, event_id DESC
      LIMIT 1`,
    [event.project_id, event.event_id, event.created_at],
  );
  return participantAccountIds(rows[0]?.payload_json ?? ({} as any));
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

function isoOrNull(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

async function collaboratorRowsForAccount(
  db: PoolClient,
  account_id: string,
): Promise<AccountFeedCollaboratorRow[]> {
  const { rows } = await db.query<{
    collaborator_account_id: string;
    common_project_count: number;
    first_name: string | null;
    last_name: string | null;
    name: string | null;
    last_active: Date | null;
    profile: Record<string, any> | null;
    updated_at: Date | null;
  }>(
    `SELECT
       collaborator_account_id,
       common_project_count,
       first_name,
       last_name,
       name,
       last_active,
       profile,
       updated_at
     FROM account_collaborator_index
     WHERE account_id = $1
       AND collaborator_account_id <> $1
     ORDER BY
       common_project_count DESC,
       COALESCE(last_active, updated_at) DESC NULLS LAST,
       collaborator_account_id ASC`,
    [account_id],
  );
  return rows.map((row) => ({
    account_id: row.collaborator_account_id,
    first_name: row.first_name,
    last_name: row.last_name,
    name: row.name,
    last_active: isoOrNull(row.last_active),
    profile: row.profile ?? null,
    common_project_count: row.common_project_count,
    updated_at: isoOrNull(row.updated_at),
  }));
}

function collaboratorFeedEventsForAccount(opts: {
  account_id: string;
  previous_rows: AccountFeedCollaboratorRow[];
  current_rows: AccountFeedCollaboratorRow[];
}): AccountFeedEvent[] {
  const previousIds = new Set(opts.previous_rows.map((row) => row.account_id));
  const currentIds = new Set(opts.current_rows.map((row) => row.account_id));
  const events: AccountFeedEvent[] = [];
  for (const collaborator_account_id of previousIds) {
    if (currentIds.has(collaborator_account_id)) continue;
    events.push({
      type: "collaborator.remove",
      ts: Date.now(),
      account_id: opts.account_id,
      collaborator_account_id,
      reason: "membership_removed",
    });
  }
  for (const collaborator of opts.current_rows) {
    events.push({
      type: "collaborator.upsert",
      ts: Date.now(),
      account_id: opts.account_id,
      collaborator,
    });
  }
  return events;
}

export async function loadLatestCollaboratorProjectionEvent(opts: {
  db: PoolClient;
  project_id: string;
}): Promise<ProjectOutboxEventRow | null> {
  const { rows } = await opts.db.query<ProjectOutboxEventRow>(
    `SELECT
       event_id,
       project_id,
       owning_bay_id,
       event_type,
       payload_json,
       created_at,
       published_at
     FROM project_events_outbox
     WHERE project_id = $1
       AND event_type = ANY($2::TEXT[])
     ORDER BY created_at DESC, event_id DESC
     LIMIT 1`,
    [opts.project_id, RELEVANT_EVENT_TYPES],
  );
  return rows[0] ?? null;
}

export async function applyProjectEventToAccountCollaboratorIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: ProjectOutboxEventRow;
}): Promise<{
  inserted_rows: number;
  deleted_rows: number;
  feed_events: AccountFeedEvent[];
}> {
  const current = participantAccountIds(opts.event.payload_json);
  const previous = await previousParticipantAccountIds(opts.db, opts.event);
  const impacted = [...new Set([...current, ...previous])];
  const localAccounts = await localHomeAccountIds(opts.db, {
    bay_id: opts.bay_id,
    account_ids: impacted,
  });

  let inserted_rows = 0;
  let deleted_rows = 0;
  const feed_events: AccountFeedEvent[] = [];
  for (const account_id of impacted) {
    if (!localAccounts.has(account_id)) continue;
    const previous_rows = await collaboratorRowsForAccount(opts.db, account_id);
    const result = await replaceAccountCollaboratorIndexRows({
      db: opts.db,
      account_id,
    });
    const current_rows = await collaboratorRowsForAccount(opts.db, account_id);
    inserted_rows += result.inserted_rows;
    deleted_rows += result.deleted_rows;
    feed_events.push(
      ...collaboratorFeedEventsForAccount({
        account_id,
        previous_rows,
        current_rows,
      }),
    );
  }
  return {
    inserted_rows,
    deleted_rows,
    feed_events,
  };
}

export async function getAccountCollaboratorIndexProjectionBacklogStatus(opts?: {
  bay_id?: string;
  now?: Date;
}): Promise<AccountCollaboratorIndexProjectionBacklogStatus> {
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
       AND event_type = ANY($2::TEXT[])
     GROUP BY event_type
     ORDER BY event_type ASC`,
    [bay_id, RELEVANT_EVENT_TYPES],
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

export async function drainAccountCollaboratorIndexProjection(opts?: {
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<DrainAccountCollaboratorIndexProjectionResult> {
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
         COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1::TEXT) AS owning_bay_id,
         event_type,
         payload_json,
         created_at,
         published_at
       FROM project_events_outbox
       WHERE COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $1::TEXT) = $1::TEXT
         AND published_at IS NULL
         AND event_type = ANY($2::TEXT[])
       ORDER BY created_at ASC, event_id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [bay_id, RELEVANT_EVENT_TYPES, limit],
    );

    const result: DrainAccountCollaboratorIndexProjectionResult = {
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
      result.event_types[event.event_type] =
        (result.event_types[event.event_type] ?? 0) + 1;
      const applied = await applyProjectEventToAccountCollaboratorIndex({
        db: client,
        bay_id,
        event,
      });
      result.applied_events += 1;
      result.inserted_rows += applied.inserted_rows;
      result.deleted_rows += applied.deleted_rows;
      result.feed_events.push(...applied.feed_events);
      if (!dry_run) {
        await client.query(
          `UPDATE project_events_outbox
              SET published_at = NOW()
            WHERE event_id = $1`,
          [event.event_id],
        );
      }
    }

    if (dry_run) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
