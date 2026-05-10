/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { NotificationCategory } from "@cocalc/util/notification-preferences";
import {
  normalizeEmailLane,
  type EmailLane,
} from "@cocalc/util/notification-email";
import { isValidUUID } from "@cocalc/util/misc";

export type NotificationEmailDeliveryMode = "immediate" | "digest" | "off";

export type NotificationEmailStatus =
  | "queued"
  | "sending"
  | "sent"
  | "skipped_preference"
  | "skipped_no_recipient"
  | "skipped_unverified"
  | "skipped_rate_limited"
  | "skipped_no_backend"
  | "failed";

const DELIVERY_MODES = new Set(["immediate", "digest", "off"]);
const DELIVERY_STATUSES = new Set([
  "queued",
  "sending",
  "sent",
  "skipped_preference",
  "skipped_no_recipient",
  "skipped_unverified",
  "skipped_rate_limited",
  "skipped_no_backend",
  "failed",
]);

export interface NotificationEmailOutboxRow {
  email_id: string;
  notification_id: string | null;
  event_id: string | null;
  target_account_id: string;
  actor_account_id: string | null;
  responsible_account_id: string | null;
  category: NotificationCategory;
  lane: EmailLane;
  delivery_mode: NotificationEmailDeliveryMode;
  recipient_email: string | null;
  subject: string;
  summary_json: Record<string, any>;
  status: NotificationEmailStatus;
  scheduled_at: Date;
  sent_at: Date | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EnqueueNotificationEmailInput {
  notification_id?: string | null;
  event_id?: string | null;
  target_account_id: string;
  actor_account_id?: string | null;
  responsible_account_id?: string | null;
  category: NotificationCategory;
  lane: EmailLane;
  delivery_mode: NotificationEmailDeliveryMode;
  recipient_email?: string | null;
  subject: string;
  summary_json?: Record<string, any>;
  status?: NotificationEmailStatus;
  scheduled_at?: Date | string | null;
  last_error?: string | null;
  dedupe_by_notification_id?: boolean;
}

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

function queryable(db?: Queryable): Queryable {
  return db ?? getPool();
}

function normalizeUuid(
  value: string | undefined | null,
  label: string,
): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw Error(`invalid ${label} '${value ?? ""}'`);
  }
  return normalized;
}

function normalizeOptionalUuid(
  value: string | undefined | null,
  label: string,
): string | null {
  if (value == null || `${value}`.trim() === "") return null;
  return normalizeUuid(value, label);
}

function normalizeDate(value?: Date | string | null): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) {
    throw Error(`invalid date '${value ?? ""}'`);
  }
  return date;
}

function normalizeDeliveryMode(value: unknown): NotificationEmailDeliveryMode {
  const mode = `${value ?? ""}`.trim();
  if (!DELIVERY_MODES.has(mode)) {
    throw Error(`invalid notification email delivery mode '${value ?? ""}'`);
  }
  return mode as NotificationEmailDeliveryMode;
}

function normalizeStatus(value: unknown): NotificationEmailStatus {
  const status = `${value ?? "queued"}`.trim();
  if (!DELIVERY_STATUSES.has(status)) {
    throw Error(`invalid notification email status '${value ?? ""}'`);
  }
  return status as NotificationEmailStatus;
}

function normalizeRequiredText(value: unknown, label: string): string {
  const text = `${value ?? ""}`.trim();
  if (!text) {
    throw Error(`${label} is required`);
  }
  return text;
}

export async function enqueueNotificationEmail(
  opts: EnqueueNotificationEmailInput & { db?: Queryable },
): Promise<string> {
  const db = queryable(opts.db);
  const status = normalizeStatus(opts.status);
  const scheduled_at = normalizeDate(opts.scheduled_at);
  const notification_id = normalizeOptionalUuid(
    opts.notification_id,
    "notification id",
  );
  if (opts.dedupe_by_notification_id !== false && notification_id != null) {
    const existing = await db.query(
      `SELECT email_id
         FROM notification_email_outbox
        WHERE notification_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [notification_id],
    );
    const existing_email_id = `${existing.rows[0]?.email_id ?? ""}`.trim();
    if (existing_email_id) {
      return existing_email_id;
    }
  }
  const result = await db.query(
    `INSERT INTO notification_email_outbox
       (email_id, notification_id, event_id, target_account_id,
        actor_account_id, responsible_account_id, category, lane,
        delivery_mode, recipient_email, subject, summary_json, status,
        scheduled_at, sent_at, attempt_count, last_error, created_at,
        updated_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9,
        $10, $11::JSONB, $12, $13, NULL, 0, $14, NOW(), NOW())
     RETURNING email_id`,
    [
      notification_id,
      normalizeOptionalUuid(opts.event_id, "event id"),
      normalizeUuid(opts.target_account_id, "target account id"),
      normalizeOptionalUuid(opts.actor_account_id, "actor account id"),
      normalizeOptionalUuid(
        opts.responsible_account_id,
        "responsible account id",
      ),
      normalizeRequiredText(opts.category, "category"),
      normalizeEmailLane(opts.lane),
      normalizeDeliveryMode(opts.delivery_mode),
      opts.recipient_email == null ? null : `${opts.recipient_email}`.trim(),
      normalizeRequiredText(opts.subject, "subject"),
      JSON.stringify(opts.summary_json ?? {}),
      status,
      scheduled_at,
      opts.last_error == null ? null : `${opts.last_error}`,
    ],
  );
  const email_id = `${result.rows[0]?.email_id ?? ""}`.trim();
  if (!email_id) {
    throw Error("failed to enqueue notification email");
  }
  return email_id;
}

export async function claimQueuedNotificationEmails(opts?: {
  limit?: number;
  db?: Queryable;
}): Promise<NotificationEmailOutboxRow[]> {
  const db = queryable(opts?.db);
  const limit = Math.max(1, Math.min(100, Math.floor(opts?.limit ?? 25)));
  const result = await db.query(
    `UPDATE notification_email_outbox
        SET status = 'sending',
            attempt_count = attempt_count + 1,
            updated_at = NOW()
      WHERE email_id IN (
        SELECT email_id
        FROM notification_email_outbox
        WHERE (status = 'queued'
               OR (status = 'sending'
                   AND updated_at < NOW() - interval '15 minutes'))
          AND delivery_mode = 'immediate'
          AND scheduled_at <= NOW()
        ORDER BY scheduled_at ASC, created_at ASC, email_id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [limit],
  );
  return result.rows as NotificationEmailOutboxRow[];
}

export async function markNotificationEmailSent(opts: {
  email_id: string;
  db?: Queryable;
}): Promise<void> {
  const db = queryable(opts.db);
  await db.query(
    `UPDATE notification_email_outbox
        SET status = 'sent',
            sent_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE email_id = $1`,
    [normalizeUuid(opts.email_id, "email id")],
  );
}

export async function markNotificationEmailFailed(opts: {
  email_id: string;
  error: string | Error;
  db?: Queryable;
}): Promise<void> {
  const db = queryable(opts.db);
  const error =
    opts.error instanceof Error ? opts.error.message : `${opts.error ?? ""}`;
  await db.query(
    `UPDATE notification_email_outbox
        SET status = 'failed',
            last_error = $2,
            updated_at = NOW()
      WHERE email_id = $1`,
    [normalizeUuid(opts.email_id, "email id"), error],
  );
}

export async function markNotificationEmailStatus(opts: {
  email_id: string;
  status: Exclude<NotificationEmailStatus, "queued" | "sending" | "sent">;
  error?: string | Error | null;
  db?: Queryable;
}): Promise<void> {
  const db = queryable(opts.db);
  const error =
    opts.error == null
      ? null
      : opts.error instanceof Error
        ? opts.error.message
        : `${opts.error}`;
  await db.query(
    `UPDATE notification_email_outbox
        SET status = $2,
            last_error = $3,
            updated_at = NOW()
      WHERE email_id = $1`,
    [
      normalizeUuid(opts.email_id, "email id"),
      normalizeStatus(opts.status),
      error,
    ],
  );
}
