/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  claimQueuedNotificationEmails,
  markNotificationEmailFailed,
  markNotificationEmailSent,
  markNotificationEmailStatus,
  type NotificationEmailOutboxRow,
} from "@cocalc/database/postgres/notification-email-outbox";
import { getServerSettings } from "@cocalc/database/settings";
import sendEmail, { isEmailConfigured } from "@cocalc/server/email/send-email";
import siteUrl from "@cocalc/server/hub/site-url";
import type { Message } from "@cocalc/server/email/message";
import { checkNotificationEmailSendLimitForAccount } from "@cocalc/server/membership/notification-email-limits";

const logger = getLogger("server:notifications:email-outbox");

const ENABLED =
  `${process.env.COCALC_NOTIFICATION_EMAIL_OUTBOX_WORKER_ENABLED ?? "1"}`.trim() !==
  "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_NOTIFICATION_EMAIL_OUTBOX_WORKER_INTERVAL_MS,
  10_000,
  1_000,
  10 * 60_000,
);
const BATCH_LIMIT = clampInt(
  process.env.COCALC_NOTIFICATION_EMAIL_OUTBOX_WORKER_BATCH_LIMIT,
  25,
  1,
  100,
);

let timer: NodeJS.Timeout | undefined;
let running = false;

export interface SendQueuedNotificationEmailBatchResult {
  claimed: number;
  sent: number;
  skipped_no_backend: number;
  failed: number;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function escapeHtml(value: unknown): string {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = `${value ?? ""}`.trim();
    if (text) return text;
  }
  return "";
}

function notificationBodyText(row: NotificationEmailOutboxRow): string {
  const summary = row.summary_json?.summary ?? {};
  const eventPayload = row.summary_json?.event_payload ?? {};
  const body = firstNonEmpty(
    summary.body_markdown,
    eventPayload.body_markdown,
    summary.description,
    eventPayload.description,
  );
  const path = firstNonEmpty(summary.path, row.summary_json?.source_path);
  return [body, path ? `Path: ${path}` : ""].filter(Boolean).join("\n\n");
}

async function buildMessage(row: NotificationEmailOutboxRow): Promise<Message> {
  const { help_email, site_name } = await getServerSettings();
  const notificationsUrl = await siteUrl("notifications");
  const body = notificationBodyText(row);
  const text = [
    body || "You have a CoCalc notification.",
    "",
    `Open notifications: ${notificationsUrl}`,
  ].join("\n");
  const html = `
<p>${escapeHtml(body || "You have a CoCalc notification.")}</p>
<p><a href="${escapeHtml(notificationsUrl)}">Open notifications in ${escapeHtml(
    site_name,
  )}</a>.</p>
`;
  return {
    from: help_email,
    to: row.recipient_email!,
    subject: row.subject,
    text,
    html,
    categories: [`notification-${row.category}`, row.lane],
  };
}

export async function sendQueuedNotificationEmailBatch(opts?: {
  limit?: number;
  sender?: typeof sendEmail;
  emailConfigured?: typeof isEmailConfigured;
  sendLimitChecker?: typeof checkNotificationEmailSendLimitForAccount;
}): Promise<SendQueuedNotificationEmailBatchResult> {
  const rows = await claimQueuedNotificationEmails({
    limit: opts?.limit ?? BATCH_LIMIT,
  });
  const result: SendQueuedNotificationEmailBatchResult = {
    claimed: rows.length,
    sent: 0,
    skipped_no_backend: 0,
    failed: 0,
  };
  const sender = opts?.sender ?? sendEmail;
  const emailConfigured = opts?.emailConfigured ?? isEmailConfigured;
  const sendLimitChecker =
    opts?.sendLimitChecker ?? checkNotificationEmailSendLimitForAccount;
  for (const row of rows) {
    try {
      if (!(await emailConfigured(row.lane))) {
        await markNotificationEmailStatus({
          email_id: row.email_id,
          status: "skipped_no_backend",
          error: `no backend configured for ${row.lane} email lane`,
        });
        result.skipped_no_backend += 1;
        continue;
      }
      if (!row.recipient_email) {
        await markNotificationEmailStatus({
          email_id: row.email_id,
          status: "skipped_no_recipient",
          error: "recipient email is missing",
        });
        result.failed += 1;
        continue;
      }
      if (row.responsible_account_id) {
        const sendLimit = await sendLimitChecker(row.responsible_account_id);
        if (!sendLimit.allowed) {
          await markNotificationEmailStatus({
            email_id: row.email_id,
            status: "skipped_rate_limited",
            error: `responsible account exceeded notification email ${sendLimit.blocked_by} send limit`,
          });
          result.failed += 1;
          continue;
        }
      }
      await sender(
        await buildMessage(row),
        row.responsible_account_id ?? undefined,
        row.lane,
      );
      await markNotificationEmailSent({ email_id: row.email_id });
      result.sent += 1;
    } catch (err) {
      await markNotificationEmailFailed({
        email_id: row.email_id,
        error: err instanceof Error ? err : `${err}`,
      });
      result.failed += 1;
      logger.warn("failed to send notification email outbox row", {
        email_id: row.email_id,
        target_account_id: row.target_account_id,
        lane: row.lane,
        err: `${err}`,
      });
    }
  }
  return result;
}

export async function runNotificationEmailOutboxMaintenanceTick(): Promise<SendQueuedNotificationEmailBatchResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await sendQueuedNotificationEmailBatch();
    if (result.claimed > 0 || result.failed > 0) {
      logger.info("notification email outbox tick", result);
    }
    return result;
  } finally {
    running = false;
  }
}

export function startNotificationEmailOutboxMaintenance(): void {
  if (!ENABLED) {
    logger.info("notification email outbox worker disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void runNotificationEmailOutboxMaintenanceTick().catch((err) => {
      logger.warn("notification email outbox tick failed", { err: `${err}` });
    });
  }, INTERVAL_MS);
  timer.unref?.();
  void runNotificationEmailOutboxMaintenanceTick().catch((err) => {
    logger.warn("notification email outbox initial tick failed", {
      err: `${err}`,
    });
  });
  logger.info("notification email outbox worker started", {
    interval_ms: INTERVAL_MS,
    batch_limit: BATCH_LIMIT,
  });
}

export function stopNotificationEmailOutboxMaintenanceForTests(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
  running = false;
}
