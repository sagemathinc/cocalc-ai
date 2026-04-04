/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import {
  type MentionNotificationSourceRow,
  NOTIFICATION_MENTION_LOOKBACK_INTERVAL,
  buildMentionNotificationPayload,
} from "./notification-events-outbox";

export interface RebuildAccountNotificationIndexResult {
  bay_id: string;
  target_account_id: string;
  dry_run: boolean;
  existing_rows: number;
  source_rows: number;
  unread_rows: number;
  saved_rows: number;
  deleted_rows: number;
  inserted_rows: number;
}

export interface AccountNotificationIndexRow {
  notification_id: string;
  kind: string;
  project_id: string | null;
  summary: Record<string, any>;
  read_state: Record<string, any>;
  created_at: Date | null;
  updated_at: Date | null;
}

export type NotificationInboxState = "all" | "unread" | "saved" | "archived";

export interface AccountNotificationCounts {
  total: number;
  unread: number;
  saved: number;
  archived: number;
  by_kind: Record<
    string,
    {
      total: number;
      unread: number;
      saved: number;
      archived: number;
    }
  >;
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function normalizeBayId(raw?: string): string {
  const bay_id = `${raw ?? ""}`.trim();
  if (!bay_id) {
    throw Error("bay_id is required");
  }
  return bay_id;
}

function normalizeUuid(raw: string | undefined, label: string): string {
  const value = `${raw ?? ""}`.trim();
  if (!isValidUUID(value)) {
    throw Error(`invalid ${label} '${raw ?? ""}'`);
  }
  return value;
}

function normalizeAccountId(raw?: string): string {
  return normalizeUuid(raw, "account id");
}

function normalizeLimit(raw?: number): number {
  const limit = raw ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw Error("limit must be a positive integer");
  }
  return limit;
}

function normalizeNotificationInboxState(raw?: string): NotificationInboxState {
  const state = `${raw ?? "all"}`.trim() || "all";
  if (!["all", "unread", "saved", "archived"].includes(state)) {
    throw Error(`invalid notification state '${raw ?? ""}'`);
  }
  return state as NotificationInboxState;
}

function normalizeOptionalProjectId(
  raw?: string | null,
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw == null || `${raw}`.trim() === "") return null;
  return normalizeUuid(raw, "project id");
}

export async function listProjectedNotificationsForAccount(opts: {
  account_id: string;
  limit?: number;
  notification_id?: string;
  kind?: string;
  project_id?: string | null;
  state?: NotificationInboxState;
}): Promise<AccountNotificationIndexRow[]> {
  const account_id = normalizeAccountId(opts.account_id);
  const limit = normalizeLimit(opts.limit);
  const state = normalizeNotificationInboxState(opts.state);
  const where: string[] = ["account_id = $1::UUID"];
  const params: any[] = [account_id];
  let i = params.length;
  if (opts.notification_id != null) {
    i += 1;
    where.push(`notification_id = $${i}::UUID`);
    params.push(normalizeUuid(opts.notification_id, "notification id"));
  }
  if (opts.kind != null) {
    i += 1;
    where.push(`kind = $${i}::TEXT`);
    params.push(`${opts.kind}`);
  }
  const project_id = normalizeOptionalProjectId(opts.project_id);
  if (project_id !== undefined) {
    if (project_id == null) {
      where.push("project_id IS NULL");
    } else {
      i += 1;
      where.push(`project_id = $${i}::UUID`);
      params.push(project_id);
    }
  }
  if (state === "unread") {
    where.push(
      "COALESCE((read_state ->> 'read')::BOOLEAN, FALSE) IS NOT TRUE AND COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS NOT TRUE",
    );
  } else if (state === "saved") {
    where.push(
      "COALESCE((read_state ->> 'saved')::BOOLEAN, FALSE) IS TRUE AND COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS NOT TRUE",
    );
  } else if (state === "archived") {
    where.push("COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS TRUE");
  }
  i += 1;
  params.push(limit);
  const { rows } = await getPool().query<AccountNotificationIndexRow>(
    `SELECT
       notification_id,
       kind,
       project_id,
       summary,
       read_state,
       created_at,
       updated_at
     FROM account_notification_index
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC NULLS LAST, updated_at DESC NULLS LAST, notification_id ASC
     LIMIT $${i}`,
    params,
  );
  return rows;
}

export async function getProjectedNotificationCounts(opts: {
  account_id: string;
}): Promise<AccountNotificationCounts> {
  const account_id = normalizeAccountId(opts.account_id);
  const { rows } = await getPool().query<{
    kind: string;
    total: string | number;
    unread: string | number;
    saved: string | number;
    archived: string | number;
  }>(
    `SELECT
       kind,
       COUNT(*)::INT AS total,
       COUNT(*) FILTER (
         WHERE COALESCE((read_state ->> 'read')::BOOLEAN, FALSE) IS NOT TRUE
           AND COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS NOT TRUE
       )::INT AS unread,
       COUNT(*) FILTER (
         WHERE COALESCE((read_state ->> 'saved')::BOOLEAN, FALSE) IS TRUE
           AND COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS NOT TRUE
       )::INT AS saved,
       COUNT(*) FILTER (
         WHERE COALESCE((read_state ->> 'archived')::BOOLEAN, FALSE) IS TRUE
       )::INT AS archived
     FROM account_notification_index
     WHERE account_id = $1::UUID
     GROUP BY kind
     ORDER BY kind ASC`,
    [account_id],
  );
  const result: AccountNotificationCounts = {
    total: 0,
    unread: 0,
    saved: 0,
    archived: 0,
    by_kind: {},
  };
  for (const row of rows) {
    const counts = {
      total: Number(row.total ?? 0),
      unread: Number(row.unread ?? 0),
      saved: Number(row.saved ?? 0),
      archived: Number(row.archived ?? 0),
    };
    result.by_kind[row.kind] = counts;
    result.total += counts.total;
    result.unread += counts.unread;
    result.saved += counts.saved;
    result.archived += counts.archived;
  }
  return result;
}

export async function setProjectedNotificationReadState(opts: {
  account_id: string;
  notification_ids: string[];
  read: boolean;
}): Promise<{ updated_count: number }> {
  const account_id = normalizeAccountId(opts.account_id);
  const rawIds = Array.isArray(opts.notification_ids)
    ? opts.notification_ids
    : [];
  const notification_ids = Array.from(
    new Set(
      rawIds.map((notification_id) =>
        normalizeUuid(notification_id, "notification id"),
      ),
    ),
  );
  if (notification_ids.length === 0) {
    throw Error("at least one notification id is required");
  }
  const { rowCount } = await getPool().query(
    `UPDATE account_notification_index
        SET read_state = jsonb_set(
              COALESCE(read_state, '{}'::JSONB),
              '{read}',
              to_jsonb($3::BOOLEAN),
              TRUE
            ),
            updated_at = NOW()
      WHERE account_id = $1::UUID
        AND notification_id = ANY($2::UUID[])`,
    [account_id, notification_ids, opts.read],
  );
  return {
    updated_count: rowCount ?? 0,
  };
}

async function assertAccountIsHomedLocally(opts: {
  account_id: string;
  bay_id: string;
}): Promise<void> {
  const { rows } = await getPool().query<{
    account_id: string;
    home_bay_id: string;
  }>(
    `SELECT
        account_id,
        COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) AS home_bay_id
       FROM accounts
      WHERE account_id = $1
        AND (deleted IS NULL OR deleted = FALSE)
      LIMIT 1`,
    [opts.account_id, opts.bay_id],
  );
  const row = rows[0];
  if (!row?.account_id) {
    throw Error(`account '${opts.account_id}' not found`);
  }
  if (row.home_bay_id !== opts.bay_id) {
    throw Error(
      `account '${opts.account_id}' is not homed in bay '${opts.bay_id}'`,
    );
  }
}

async function getExistingRowCount(account_id: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
       FROM account_notification_index
      WHERE account_id = $1`,
    [account_id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function loadMentionNotificationSourceRowsForAccount(
  account_id: string,
): Promise<MentionNotificationSourceRow[]> {
  const { rows } = await getPool().query<MentionNotificationSourceRow>(
    `SELECT
       m.time,
       m.project_id,
       m.path,
       m.source,
       m.target,
       m.priority,
       m.description,
       m.fragment_id,
       COALESCE(m.users -> m.target, '{}'::JSONB) AS read_state,
       COALESCE(NULLIF(BTRIM(p.owning_bay_id), ''), 'bay-0') AS owning_bay_id
     FROM mentions m
     JOIN projects p
       ON p.project_id = m.project_id
     WHERE m.target = $1::TEXT
       AND m.time >= NOW() - INTERVAL '${NOTIFICATION_MENTION_LOOKBACK_INTERVAL}'
       AND COALESCE(p.deleted, FALSE) IS NOT TRUE
     ORDER BY m.time DESC, m.project_id ASC, m.path ASC`,
    [account_id],
  );
  return rows;
}

export async function replaceAccountNotificationIndexRows(opts: {
  db: Queryable;
  account_id: string;
  rows: MentionNotificationSourceRow[];
}): Promise<{ deleted_rows: number; inserted_rows: number }> {
  const account_id = normalizeAccountId(opts.account_id);
  const deleted = await opts.db.query(
    `DELETE FROM account_notification_index
      WHERE account_id = $1`,
    [account_id],
  );
  let inserted_rows = 0;
  for (const row of opts.rows) {
    const payload = buildMentionNotificationPayload(row);
    await opts.db.query(
      `INSERT INTO account_notification_index
         (account_id, notification_id, kind, project_id, summary, read_state,
          created_at, updated_at)
       VALUES
         ($1, $2, $3, $4, $5::JSONB, $6::JSONB, $7, $8)`,
      [
        account_id,
        payload.notification_id,
        payload.kind,
        payload.project_id,
        JSON.stringify(payload.summary),
        JSON.stringify(payload.read_state),
        payload.created_at,
        payload.updated_at,
      ],
    );
    inserted_rows += 1;
  }
  return {
    deleted_rows: deleted.rowCount ?? 0,
    inserted_rows,
  };
}

export async function rebuildAccountNotificationIndex(opts: {
  account_id: string;
  bay_id: string;
  dry_run?: boolean;
}): Promise<RebuildAccountNotificationIndexResult> {
  const account_id = normalizeAccountId(opts.account_id);
  const bay_id = normalizeBayId(opts.bay_id);
  const dry_run = opts.dry_run ?? true;

  await assertAccountIsHomedLocally({ account_id, bay_id });
  const existing_rows = await getExistingRowCount(account_id);
  const sourceRows =
    await loadMentionNotificationSourceRowsForAccount(account_id);
  const source_rows = sourceRows.length;
  const unread_rows = sourceRows.filter((row) => !row.read_state?.read).length;
  const saved_rows = sourceRows.filter((row) => !!row.read_state?.saved).length;

  if (dry_run) {
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: true,
      existing_rows,
      source_rows,
      unread_rows,
      saved_rows,
      deleted_rows: 0,
      inserted_rows: 0,
    };
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await replaceAccountNotificationIndexRows({
      db: client,
      account_id,
      rows: sourceRows,
    });
    await client.query("COMMIT");
    return {
      bay_id,
      target_account_id: account_id,
      dry_run: false,
      existing_rows,
      source_rows,
      unread_rows,
      saved_rows,
      deleted_rows: result.deleted_rows,
      inserted_rows: result.inserted_rows,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
