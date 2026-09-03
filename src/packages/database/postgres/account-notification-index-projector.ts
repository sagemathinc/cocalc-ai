/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import {
  codexNotificationEmailEnabled,
  enqueueNotificationEmail,
} from "./notification-email-outbox";
import type {
  NotificationTargetOutboxRow,
  NotificationTransportEventType,
} from "./notifications-core";
import { resolveNotificationDeliveryPolicy } from "@cocalc/util/notification-delivery-policy";
import type { NotificationDeliveryPolicy } from "@cocalc/util/notification-delivery-policy";
import { notificationModeSendsEmail } from "@cocalc/util/notification-preferences";
import { ACCOUNT_NOTIFICATION_REVISION_LOCK } from "./schema/account-notification-revision";

const DEFAULT_SINGLE_BAY_ID = "bay-0";
const RELEVANT_EVENT_TYPES: NotificationTransportEventType[] = [
  "notification.upserted",
];

type NotificationTargetOutboxPayload = {
  event_id?: string | null;
  notification_id: string;
  kind: string;
  source_project_id?: string | null;
  source_path?: string | null;
  actor_account_id?: string | null;
  origin_kind?: string | null;
  target_account_id: string;
  summary?: Record<string, any>;
  event_payload?: Record<string, any>;
  created_at?: string | null;
};

type LocalHomeAccount = {
  email_address: string | null;
  email_address_verified: Record<string, any> | null;
  other_settings: Record<string, any> | null;
};

type ExistingProjection = {
  notification_id: string;
  summary: Record<string, any>;
  read_state: Record<string, any>;
};

async function coalescedProjection(opts: {
  db: PoolClient;
  account_id: string;
  event: NotificationTargetOutboxRow;
  payload: NotificationTargetOutboxPayload;
}): Promise<ExistingProjection | undefined> {
  const summary = opts.payload.summary ?? {};
  if (opts.event.kind !== "account_notice") {
    return;
  }
  const noticeType = `${summary.notice_type ?? ""}`;
  let extraClause: string;
  let extraValue: string;
  if (noticeType === "codex_attention" && summary.attention_id) {
    extraClause = "summary->>'attention_id' = $4";
    extraValue = `${summary.attention_id}`;
  } else if (noticeType === "codex_turn_completion" && summary.thread_id) {
    extraClause = "summary->>'thread_id' = $4";
    extraValue = `${summary.thread_id}`;
  } else {
    return;
  }
  const { rows } = await opts.db.query<ExistingProjection>(
    `SELECT notification_id, summary, read_state
       FROM account_notification_index
      WHERE account_id = $1::UUID
        AND kind = 'account_notice'
        AND project_id IS NOT DISTINCT FROM $2::UUID
        AND summary->>'notice_type' = $3
        AND ${extraClause}
      ORDER BY updated_at DESC
      LIMIT 1`,
    [
      opts.account_id,
      opts.payload.source_project_id ?? null,
      noticeType,
      extraValue,
    ],
  );
  return rows[0];
}

function projectedSummary(opts: {
  incoming: Record<string, any>;
  existing?: ExistingProjection;
  created_at: string;
}): { summary: Record<string, any>; is_new_source: boolean } {
  if (opts.incoming.notice_type !== "codex_turn_completion") {
    return { summary: opts.incoming, is_new_source: !opts.existing };
  }
  const oldSummary = opts.existing?.summary ?? {};
  const oldSource = `${oldSummary.stable_source_id ?? ""}`;
  const newSource = `${opts.incoming.stable_source_id ?? ""}`;
  const is_new_source = !opts.existing || !newSource || oldSource !== newSource;
  const oldCount = Math.max(1, Number(oldSummary.coalesced_count ?? 1) || 1);
  return {
    is_new_source,
    summary: {
      ...opts.incoming,
      coalesced_count: is_new_source
        ? oldCount + (opts.existing ? 1 : 0)
        : oldCount,
      first_completion_at:
        oldSummary.first_completion_at ??
        oldSummary.completed_at ??
        opts.incoming.completed_at ??
        opts.created_at,
    },
  };
}

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

async function loadLocalHomeAccount(
  db: PoolClient,
  opts: { bay_id: string; account_id: string },
): Promise<LocalHomeAccount | undefined> {
  const { rows } = await db.query<LocalHomeAccount>(
    `SELECT email_address, email_address_verified, other_settings
       FROM accounts
      WHERE account_id = $1::UUID
        AND (deleted IS NULL OR deleted = FALSE)
        AND COALESCE(NULLIF(BTRIM(home_bay_id), ''), $2::TEXT) = $2::TEXT
      LIMIT 1`,
    [opts.account_id, opts.bay_id],
  );
  return rows[0] as LocalHomeAccount | undefined;
}

async function lockAccountProjection(
  db: PoolClient,
  account_id: string,
): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
    ACCOUNT_NOTIFICATION_REVISION_LOCK,
    account_id,
  ]);
}

async function applyNotificationEventToAccountNotificationIndex(opts: {
  db: PoolClient;
  bay_id: string;
  event: NotificationTargetOutboxRow;
  require_local_account?: boolean;
}): Promise<{
  inserted_rows: number;
  deleted_rows: number;
  affected_account_id?: string;
  affected_notification_id?: string;
}> {
  const { db, bay_id, event } = opts;
  const account = await loadLocalHomeAccount(db, {
    bay_id,
    account_id: event.target_account_id,
  });
  if (account == null) {
    if (opts.require_local_account === true) {
      throw Error(
        `notification target account '${event.target_account_id}' is not local to ${bay_id}`,
      );
    }
    return {
      inserted_rows: 0,
      deleted_rows: 0,
      affected_account_id: undefined,
      affected_notification_id: undefined,
    };
  }
  // Different projector workers can claim distinct outbox rows for the same
  // account. Serialize the coalescing read and write so they reuse one row.
  await lockAccountProjection(db, event.target_account_id);
  const payload = (event.payload_json ?? {}) as NotificationTargetOutboxPayload;
  const policy = resolveNotificationDeliveryPolicy({
    kind: event.kind,
    origin_kind: payload.origin_kind,
    actor_account_id: payload.actor_account_id,
    target_account_id: event.target_account_id,
    summary: payload.summary,
    event_payload: payload.event_payload,
    preferences: account.other_settings?.notification_preferences,
    preferences_v2: account.other_settings?.notification_preferences_v2,
    onboarding_email_declined:
      account.other_settings?.marketing_email_consent_record?.source ===
        "first-project-open" &&
      account.other_settings?.marketing_email_consent_record?.enabled === false,
  });
  const existingProjection = await coalescedProjection({
    db,
    account_id: event.target_account_id,
    event,
    payload,
  });
  const projectionNotificationId =
    existingProjection?.notification_id ?? event.notification_id;
  const projection = projectedSummary({
    incoming: payload.summary ?? {},
    existing: existingProjection,
    created_at: payload.created_at ?? event.created_at.toISOString(),
  });
  const shouldReplaceReadState =
    !policy.creates_in_app ||
    (policy.creates_in_app &&
      existingProjection?.read_state?.archived === true) ||
    (payload.summary?.notice_type === "codex_turn_completion" &&
      projection.is_new_source);
  const delivery_mode = policy.delivery_mode;
  const insertProjection = policy.creates_in_app || policy.category === "ai";
  if (insertProjection) {
    await db.query(
      `INSERT INTO account_notification_index
       (account_id, notification_id, kind, project_id, summary, read_state,
        created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5::JSONB, $6::JSONB, $7, $8)
     ON CONFLICT (account_id, notification_id)
     DO UPDATE SET
       kind = EXCLUDED.kind,
       project_id = EXCLUDED.project_id,
       summary = EXCLUDED.summary,
       read_state = CASE
         WHEN $9::BOOLEAN THEN EXCLUDED.read_state
         ELSE account_notification_index.read_state
       END,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at`,
      [
        event.target_account_id,
        projectionNotificationId,
        event.kind,
        payload.source_project_id ?? null,
        JSON.stringify(projection.summary),
        JSON.stringify(
          policy.creates_in_app ? {} : { read: true, archived: true },
        ),
        payload.created_at ?? event.created_at.toISOString(),
        event.created_at,
        shouldReplaceReadState,
      ],
    );
  }
  if (insertProjection || notificationModeSendsEmail(delivery_mode)) {
    await enqueueProjectedNotificationEmail({
      db,
      event,
      payload,
      account,
      notification_id:
        payload.summary?.notice_type === "codex_attention"
          ? projectionNotificationId
          : event.notification_id,
      projection_notification_id: projectionNotificationId,
      policy: policy.creates_in_app
        ? { ...policy, delivery_mode, creates_in_app: true }
        : policy,
    });
  }
  return {
    inserted_rows: insertProjection ? 1 : 0,
    deleted_rows: 0,
    affected_account_id: insertProjection ? event.target_account_id : undefined,
    affected_notification_id: insertProjection
      ? projectionNotificationId
      : undefined,
  };
}

export async function applyNotificationTargetOutboxRowToAccountNotificationIndex(opts: {
  bay_id: string;
  event: NotificationTargetOutboxRow;
  require_local_account?: boolean;
}): Promise<{
  inserted_rows: number;
  deleted_rows: number;
  affected_account_id?: string;
  affected_notification_id?: string;
}> {
  const bay_id = normalizeBayId(opts.bay_id);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await applyNotificationEventToAccountNotificationIndex({
      db: client,
      bay_id,
      event: opts.event,
      require_local_account: opts.require_local_account,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function enqueueProjectedNotificationEmail(opts: {
  db: PoolClient;
  event: NotificationTargetOutboxRow;
  payload: NotificationTargetOutboxPayload;
  account: LocalHomeAccount;
  notification_id: string;
  projection_notification_id: string;
  policy: NotificationDeliveryPolicy;
}): Promise<void> {
  const { db, event, payload, account, policy } = opts;
  if (
    payload.summary?.notice_type === "codex_attention" &&
    (payload.summary?.attention_state !== "pending" ||
      payload.summary?.acknowledged_at != null)
  ) {
    await db.query(
      `UPDATE notification_email_outbox
          SET status = 'skipped_preference',
              last_error = $2,
              updated_at = NOW()
        WHERE notification_id = $1::UUID AND status = 'queued'`,
      [
        opts.notification_id,
        payload.summary?.attention_state !== "pending"
          ? "attention request resolved before escalation"
          : "attention request acknowledged before escalation",
      ],
    );
    return;
  }
  const snoozedUntil = Number(payload.summary?.snoozed_until ?? 0);
  if (
    payload.summary?.notice_type === "codex_attention" &&
    Number.isFinite(snoozedUntil) &&
    snoozedUntil > Date.now()
  ) {
    await db.query(
      `UPDATE notification_email_outbox
          SET scheduled_at = GREATEST(scheduled_at, TO_TIMESTAMP($2 / 1000.0)),
              updated_at = NOW()
        WHERE notification_id = $1::UUID AND status = 'queued'`,
      [opts.notification_id, snoozedUntil],
    );
  }
  const recipient_email = resolveRecipientEmail(account);
  const status =
    policy.category === "ai" && !codexNotificationEmailEnabled()
      ? "skipped_preference"
      : notificationModeSendsEmail(policy.delivery_mode)
        ? recipient_email
          ? "queued"
          : "skipped_no_recipient"
        : "skipped_preference";
  await enqueueNotificationEmail({
    db,
    notification_id: opts.notification_id,
    event_id: payload.event_id ?? null,
    target_account_id: event.target_account_id,
    actor_account_id: payload.actor_account_id ?? null,
    responsible_account_id: policy.responsible_account_id,
    category: policy.category,
    lane: policy.lane,
    delivery_mode:
      policy.delivery_mode === "digest"
        ? "digest"
        : policy.delivery_mode === "immediate"
          ? "immediate"
          : "off",
    recipient_email,
    subject: notificationEmailSubject({ event, payload }),
    summary_json: {
      kind: event.kind,
      summary: payload.summary ?? {},
      event_payload: payload.event_payload ?? {},
      source_project_id: payload.source_project_id ?? null,
      source_path: payload.source_path ?? null,
      projection_notification_id: opts.projection_notification_id,
      required: policy.required,
    },
    status,
    last_error:
      policy.category === "ai" && !codexNotificationEmailEnabled()
        ? "Codex notification email is disabled"
        : undefined,
    scheduled_at: new Date(
      event.created_at.getTime() + (policy.email_delay_ms ?? 0),
    ),
  });
}

function resolveRecipientEmail(
  account:
    | {
        email_address: string | null;
        email_address_verified: Record<string, any> | null;
      }
    | undefined,
): string | null {
  const primary = `${account?.email_address ?? ""}`.trim();
  if (!primary) return null;
  const verified = account?.email_address_verified;
  if (verified == null || verified[primary]) {
    return primary;
  }
  const firstVerified = Object.keys(verified).find((email) => verified[email]);
  return firstVerified || null;
}

function notificationEmailSubject(opts: {
  event: NotificationTargetOutboxRow;
  payload: NotificationTargetOutboxPayload;
}): string {
  const summary = opts.payload.summary ?? {};
  const title = `${summary.title ?? ""}`.trim();
  if (title) {
    return title;
  }
  if (opts.event.kind === "mention") {
    const path = `${
      summary.display_path ?? summary.path ?? opts.payload.source_path ?? ""
    }`.trim();
    if (summary.notification_reason === "thread_follow") {
      return path ? `CoCalc chat reply in ${path}` : "CoCalc chat reply";
    }
    return path ? `CoCalc mention in ${path}` : "CoCalc mention";
  }
  return "CoCalc notification";
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
