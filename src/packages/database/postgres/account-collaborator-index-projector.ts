/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
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

async function applyProjectEventToAccountCollaboratorIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: ProjectOutboxEventRow;
}): Promise<{ inserted_rows: number; deleted_rows: number }> {
  const current = participantAccountIds(opts.event.payload_json);
  const previous = await previousParticipantAccountIds(opts.db, opts.event);
  const impacted = [...new Set([...current, ...previous])];
  const localAccounts = await localHomeAccountIds(opts.db, {
    bay_id: opts.bay_id,
    account_ids: impacted,
  });

  let inserted_rows = 0;
  let deleted_rows = 0;
  for (const account_id of impacted) {
    if (!localAccounts.has(account_id)) continue;
    const result = await replaceAccountCollaboratorIndexRows({
      db: opts.db,
      account_id,
    });
    inserted_rows += result.inserted_rows;
    deleted_rows += result.deleted_rows;
  }
  return {
    inserted_rows,
    deleted_rows,
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
