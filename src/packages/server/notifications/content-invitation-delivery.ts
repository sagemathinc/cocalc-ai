/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import type { NotificationEmailStatus } from "@cocalc/database/postgres/notification-email-outbox";
import type { PeopleInvitationDeliveryReceipt } from "@cocalc/util/people-invitations";
import { isValidUUID } from "@cocalc/util/misc";

export interface ContentInvitationDeliveryRequest {
  recipient_account_id: string;
  sender_account_id: string;
  notification_ids: string[];
}

export interface ContentInvitationDeliveryResult {
  notification_id: string;
  delivery: PeopleInvitationDeliveryReceipt[];
}

function uuid(value: string): string {
  if (typeof value !== "string" || !isValidUUID(value)) {
    throw Error("invalid content invitation delivery identity");
  }
  return value.toLowerCase();
}

function emailReceipt(
  notification_id: string,
  status: NotificationEmailStatus | undefined,
): PeopleInvitationDeliveryReceipt {
  const common = { channel: "email" as const, receipt_id: notification_id };
  switch (status) {
    case "queued":
      return { ...common, status: "queued" };
    case "sending":
      // A claimed submission may already have reached the provider. Do not
      // suggest retrying it just because its acknowledgement is still unknown.
      return { ...common, status: "unknown", reason: "submission_in_progress" };
    case "sent":
      return { ...common, status: "sent" };
    case "failed":
      return { ...common, status: "failed", reason: "email_delivery_failed" };
    case "skipped_no_backend":
      return {
        ...common,
        status: "suppressed",
        reason: "email_not_configured",
      };
    case "skipped_no_recipient":
      return { ...common, status: "suppressed", reason: "email_unavailable" };
    case "skipped_unverified":
      return { ...common, status: "suppressed", reason: "email_unverified" };
    case "skipped_rate_limited":
      return { ...common, status: "suppressed", reason: "rate_limited" };
    case "skipped_preference":
      return {
        ...common,
        status: "suppressed",
        reason: "notification_preference",
      };
    default:
      return { ...common, status: "unknown", reason: "delivery_not_observed" };
  }
}

/** Service-internal, current RECIPIENT home only. The caller must authorize the
 * requesting sender's operation/history before routing here. Never call with a
 * browser-supplied sender identity and never query a sender-local recipient copy.
 * Reports channel delivery, not read receipts: no recipient engagement data,
 * email address, authored context, or provider error leaves this boundary.
 */
export async function readContentInvitationDeliveryOnHomeBay(
  input: ContentInvitationDeliveryRequest,
): Promise<ContentInvitationDeliveryResult[]> {
  const recipient_account_id = uuid(input.recipient_account_id);
  const sender_account_id = uuid(input.sender_account_id);
  if (
    !Array.isArray(input.notification_ids) ||
    input.notification_ids.length > 100
  ) {
    throw Error("content invitation delivery batch exceeds capacity");
  }
  const notification_ids = [...new Set(input.notification_ids.map(uuid))];
  if (!notification_ids.length) return [];
  return withAccountRehomeWriteFence({
    account_id: recipient_account_id,
    action: "read content invitation delivery receipts",
    fn: async (db) => {
      const projections = await db.query<{ notification_id: string }>(
        `SELECT notification_id FROM account_notification_index
         WHERE account_id=$1 AND notification_id=ANY($3::uuid[])
           AND kind='account_notice' AND summary->>'notice_type'='collaboration_invitation'
           AND summary->>'actor_account_id'=$2`,
        [recipient_account_id, sender_account_id, notification_ids],
      );
      const emails = await db.query<{
        notification_id: string;
        status: NotificationEmailStatus;
        channels: { notification?: boolean; email?: boolean } | null;
        creates_in_app: boolean | null;
      }>(
        `SELECT DISTINCT ON (notification_id) notification_id,status,
            summary_json->'summary'->'invitation_channels' AS channels,
            (summary_json->'delivery_policy'->>'creates_in_app')::boolean AS creates_in_app
         FROM notification_email_outbox
         WHERE target_account_id=$1 AND actor_account_id=$2
           AND notification_id=ANY($3::uuid[])
           AND summary_json->'summary'->>'notice_type'='collaboration_invitation'
         ORDER BY notification_id,created_at DESC,email_id DESC`,
        [recipient_account_id, sender_account_id, notification_ids],
      );
      const projected = new Set(
        projections.rows.map((row) => row.notification_id),
      );
      const email = new Map(
        emails.rows.map((row) => [row.notification_id, row]),
      );
      return notification_ids.map(
        (notification_id): ContentInvitationDeliveryResult => {
          const row = email.get(notification_id);
          return {
            notification_id,
            delivery: [
              {
                channel: "notification",
                receipt_id: notification_id,
                ...(projected.has(notification_id)
                  ? { status: "sent" as const }
                  : row?.channels?.notification === false
                    ? { status: "suppressed" as const, reason: "not_requested" }
                    : row?.creates_in_app === false
                      ? {
                          status: "suppressed" as const,
                          reason: "notification_preference",
                        }
                      : {
                          status: "unknown" as const,
                          reason: "delivery_not_observed",
                        }),
              },
              emailReceipt(notification_id, row?.status),
            ],
          };
        },
      );
    },
  });
}
