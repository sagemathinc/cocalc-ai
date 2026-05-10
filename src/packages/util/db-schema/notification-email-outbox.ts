/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "notification_email_outbox",
  rules: {
    primary_key: "email_id",
    pg_indexes: [
      "notification_id",
      "event_id",
      "target_account_id",
      "actor_account_id",
      "responsible_account_id",
      "category",
      "lane",
      "delivery_mode",
      "status",
      "scheduled_at",
      "created_at",
    ],
  },
  fields: {
    email_id: {
      type: "uuid",
      desc: "Stable id for this external notification email delivery row.",
    },
    notification_id: {
      type: "uuid",
      desc: "Account-facing notification id, when this email is tied to an in-app notification.",
    },
    event_id: {
      type: "uuid",
      desc: "Authoritative notification event id, when available.",
    },
    target_account_id: {
      type: "uuid",
      desc: "Account that receives this email.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Optional account that performed the action that caused this notification.",
    },
    responsible_account_id: {
      type: "uuid",
      desc: "Optional account whose notification-email sender limits are charged.",
    },
    category: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "User-facing notification category such as billing, collaboration, or ai.",
    },
    lane: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Outbound email lane such as critical, transactional, notification, or marketing.",
    },
    delivery_mode: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Resolved external delivery mode: immediate, digest, or off.",
    },
    recipient_email: {
      type: "string",
      desc: "Recipient email address resolved when the row was queued.",
    },
    subject: {
      type: "string",
      desc: "Email subject.",
    },
    summary_json: {
      type: "map",
      desc: "Compact structured email summary and rendering inputs.",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Delivery status such as queued, sending, sent, skipped_preference, skipped_no_recipient, skipped_rate_limited, skipped_no_backend, or failed.",
    },
    scheduled_at: {
      type: "timestamp",
      desc: "When this email is eligible to be sent.",
    },
    sent_at: {
      type: "timestamp",
      desc: "When the email was sent, if successful.",
    },
    attempt_count: {
      type: "integer",
      desc: "How many send attempts have been made.",
    },
    last_error: {
      type: "string",
      desc: "Most recent send failure or skip reason.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this row was created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this row was last updated.",
    },
  },
});
