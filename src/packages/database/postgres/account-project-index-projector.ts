/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
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
  event_types: Record<string, number>;
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

async function applyProjectEventToAccountProjectIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: ProjectOutboxEventRow;
}): Promise<{ inserted_rows: number; deleted_rows: number }> {
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
  if (payload.deleted) {
    return {
      inserted_rows: 0,
      deleted_rows: deleted.rowCount ?? 0,
    };
  }

  const visibleAccountIds = visibleAccountIdsFromUsers(payload.users_summary);
  const localAccounts = await localHomeAccountIds(db, {
    bay_id,
    account_ids: visibleAccountIds,
  });
  let inserted_rows = 0;
  for (const account_id of visibleAccountIds) {
    if (!localAccounts.has(account_id)) continue;
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
