/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import type {
  NotificationTargetOutboxRow,
  NotificationTransportEventType,
} from "./notifications-core";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
const RELEVANT_EVENT_TYPES: NotificationTransportEventType[] = [
  "notification.upserted",
];

type NotificationTargetOutboxPayload = {
  notification_id: string;
  kind: string;
  source_project_id?: string | null;
  target_account_id: string;
  summary?: Record<string, any>;
  created_at?: string | null;
};

export interface DrainAccountNotificationIndexProjectionResult {
  bay_id: string;
  dry_run: boolean;
  requested_limit: number;
  scanned_events: number;
  applied_events: number;
  inserted_rows: number;
  deleted_rows: number;
  affected_account_ids: string[];
  affected_notifications: Array<{
    account_id: string;
    notification_id: string;
  }>;
  event_types: Record<string, number>;
}

export interface AccountNotificationIndexProjectionBacklogStatus {
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

async function isLocalHomeAccount(
  db: PoolClient,
  opts: { bay_id: string; account_id: string },
): Promise<boolean> {
  const { rows } = await db.query<{ account_id: string }>(
    `SELECT account_id
       FROM accounts
      WHERE account_id = $1::UUID
        AND (deleted IS NULL OR deleted = FALSE)
        AND COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) = $2::TEXT
      LIMIT 1`,
    [opts.account_id, opts.bay_id],
  );
  return !!rows[0]?.account_id;
}

async function applyNotificationEventToAccountNotificationIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: NotificationTargetOutboxRow;
}): Promise<{
  inserted_rows: number;
  deleted_rows: number;
  affected_account_id?: string;
  affected_notification_id?: string;
}> {
  const { db, bay_id, event } = opts;
  if (
    !(await isLocalHomeAccount(db, {
      bay_id,
      account_id: event.target_account_id,
    }))
  ) {
    return {
      inserted_rows: 0,
      deleted_rows: 0,
      affected_account_id: undefined,
      affected_notification_id: undefined,
    };
  }
  const payload = (event.payload_json ?? {}) as NotificationTargetOutboxPayload;
  await db.query(
    `INSERT INTO account_notification_index
       (account_id, notification_id, kind, project_id, summary, read_state,
        created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5::JSONB, '{}'::JSONB, $6, $7)
     ON CONFLICT (account_id, notification_id)
     DO UPDATE SET
       kind = EXCLUDED.kind,
       project_id = EXCLUDED.project_id,
       summary = EXCLUDED.summary,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
    [
      event.target_account_id,
      event.notification_id,
      event.kind,
      payload.source_project_id ?? null,
      JSON.stringify(payload.summary ?? {}),
      payload.created_at ?? event.created_at.toISOString(),
      event.created_at,
    ],
  );
  return {
    inserted_rows: 1,
    deleted_rows: 0,
    affected_account_id: event.target_account_id,
    affected_notification_id: event.notification_id,
  };
}

export async function getAccountNotificationIndexProjectionBacklogStatus(opts?: {
  bay_id?: string;
  now?: Date;
}): Promise<AccountNotificationIndexProjectionBacklogStatus> {
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
     FROM notification_target_outbox
     WHERE COALESCE(NULLIF(BTRIM(target_home_bay_id), ''), $1::TEXT) = $1::TEXT
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

export async function drainAccountNotificationIndexProjection(opts?: {
  bay_id?: string;
  limit?: number;
  dry_run?: boolean;
}): Promise<DrainAccountNotificationIndexProjectionResult> {
  const bay_id = normalizeBayId(opts?.bay_id);
  const limit = normalizeLimit(opts?.limit);
  const dry_run = opts?.dry_run ?? true;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<NotificationTargetOutboxRow>(
      `SELECT
         outbox_id,
         COALESCE(NULLIF(BTRIM(target_home_bay_id), ''), $1::TEXT) AS target_home_bay_id,
         target_account_id,
         notification_id,
         kind,
         event_type,
         payload_json,
         created_at,
         published_at
       FROM notification_target_outbox
       WHERE COALESCE(NULLIF(BTRIM(target_home_bay_id), ''), $1::TEXT) = $1::TEXT
         AND published_at IS NULL
         AND event_type = ANY($2::TEXT[])
       ORDER BY created_at ASC, outbox_id ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [bay_id, RELEVANT_EVENT_TYPES, limit],
    );

    const result: DrainAccountNotificationIndexProjectionResult = {
      bay_id,
      dry_run,
      requested_limit: limit,
      scanned_events: rows.length,
      applied_events: 0,
      inserted_rows: 0,
      deleted_rows: 0,
      affected_account_ids: [],
      affected_notifications: [],
      event_types: {},
    };
    const affectedAccountIds = new Set<string>();
    const affectedNotifications = new Set<string>();

    for (const event of rows) {
      result.event_types[event.event_type] =
        (result.event_types[event.event_type] ?? 0) + 1;
      const applied = await applyNotificationEventToAccountNotificationIndex({
        db: client,
        bay_id,
        event,
      });
      result.applied_events += 1;
      result.inserted_rows += applied.inserted_rows;
      result.deleted_rows += applied.deleted_rows;
      if (applied.affected_account_id != null) {
        affectedAccountIds.add(applied.affected_account_id);
      }
      if (
        applied.affected_account_id != null &&
        applied.affected_notification_id != null
      ) {
        affectedNotifications.add(
          `${applied.affected_account_id}:${applied.affected_notification_id}`,
        );
      }
      if (!dry_run) {
        await client.query(
          `UPDATE notification_target_outbox
              SET published_at = NOW()
            WHERE outbox_id = $1`,
          [event.outbox_id],
        );
      }
    }
    result.affected_account_ids = Array.from(affectedAccountIds).sort();
    result.affected_notifications = Array.from(affectedNotifications)
      .sort()
      .map((value) => {
        const [account_id, notification_id] = value.split(":");
        return { account_id, notification_id };
      });

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
