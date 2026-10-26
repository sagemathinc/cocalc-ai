/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tables for CoCalc as an OAuth 2 sign-in provider for registered clients
// (currently only Sagebrush), and for asking those clients to purge a deleted
// account's data. See docs/sagebrush.md.

import { Table } from "./types";

Table({
  name: "oauth_authorization_codes",
  rules: {
    primary_key: "code_hash",
    durability: "soft",
    pg_indexes: ["expire"],
  },
  fields: {
    code_hash: {
      type: "string",
      pg_type: "char(64)",
      desc: "SHA-256 hex hash of the one-time authorization code. The code itself is never stored.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client the code was issued to.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that approved the sign-in.",
    },
    email_address: {
      type: "string",
      desc: "The verified email address of the account when it approved the sign-in.",
    },
    redirect_uri: {
      type: "string",
      desc: "Redirect URI from the authorize request; the token request must repeat it exactly.",
    },
    code_challenge: {
      type: "string",
      pg_type: "varchar(128)",
      desc: "PKCE S256 code challenge from the authorize request.",
    },
    created: {
      type: "timestamp",
      desc: "When the code was issued.",
    },
    expire: {
      type: "timestamp",
      desc: "When the code stops being valid.",
    },
    used_at: {
      type: "timestamp",
      desc: "When the first redemption attempt used up the code.",
    },
  },
});

Table({
  name: "oauth_client_approvals",
  rules: {
    primary_key: ["account_id", "client_id"],
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account that approved a sign-in for the client.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client.",
    },
    first_approved: {
      type: "timestamp",
      desc: "When the account first approved a sign-in for the client.",
    },
    last_approved: {
      type: "timestamp",
      desc: "When the account most recently approved a sign-in for the client.",
    },
  },
});

Table({
  name: "oauth_client_purge_requests",
  rules: {
    primary_key: "request_id",
    pg_indexes: ["next_attempt_at", "account_id"],
  },
  fields: {
    request_id: {
      type: "uuid",
      desc: "Idempotency id sent to the client with every attempt.",
    },
    client_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Registered OAuth client asked to purge the account's data.",
    },
    account_id: {
      type: "uuid",
      desc: "Deleted account whose data the client must purge.",
    },
    created: {
      type: "timestamp",
      desc: "When the account deletion queued this request.",
    },
    attempts: {
      type: "integer",
      desc: "Number of delivery attempts so far.",
    },
    next_attempt_at: {
      type: "timestamp",
      desc: "When the next delivery attempt is due; null once accepted.",
    },
    last_attempt_at: {
      type: "timestamp",
      desc: "When the last delivery attempt was made.",
    },
    last_error: {
      type: "string",
      desc: "Why the last delivery attempt failed.",
    },
    accepted_at: {
      type: "timestamp",
      desc: "When the client accepted the request (HTTP 202).",
    },
    alerted_at: {
      type: "timestamp",
      desc: "When admins were alerted that the request is overdue.",
    },
  },
});

Table({
  name: "sagebrush_sync_states",
  rules: {
    primary_key: "account_id",
    pg_indexes: ["checked_at", "notice_next_at", "email_next_at"],
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account that signed in to Sagebrush, on its home bay.",
    },
    sync_enabled: {
      type: "boolean",
      desc: "Whether the account's membership included Sagebrush sync when last checked.",
    },
    checked_at: {
      type: "timestamp",
      desc: "When the membership was last checked.",
    },
    changed_at: {
      type: "timestamp",
      desc: "When a change of sync_enabled was last seen (null: only the first check).",
    },
    notice_request_id: {
      type: "uuid",
      desc: "Idempotency id of the plan notice for the last change.",
    },
    notice_issued: {
      type: "number",
      pg_type: "bigint",
      desc: "The notice's issued time (ms), which Sagebrush orders notices by.",
    },
    notice_limits: {
      type: "map",
      desc: "The limits the notice sends (the limits API's answer at the change).",
    },
    notice_attempts: {
      type: "integer",
      desc: "Delivery attempts of the notice so far.",
    },
    notice_next_at: {
      type: "timestamp",
      desc: "When the next notice attempt is due; null when none is pending.",
    },
    notice_accepted_at: {
      type: "timestamp",
      desc: "When Sagebrush accepted the notice.",
    },
    purge_after: {
      type: "timestamp",
      desc: "When Sagebrush will delete the synced data, as it last answered.",
    },
    email_stage: {
      type: "string",
      pg_type: "varchar(16)",
      desc: "Retention emails after a sync membership ended: 'ended' (the first is due), 'before' (the second is due), 'done' or 'cancelled'; null when none are due.",
    },
    email_next_at: {
      type: "timestamp",
      desc: "When the next retention step (a read, then maybe an email) is due.",
    },
    email_attempts: {
      type: "integer",
      desc: "Failed attempts of the current retention step.",
    },
    ended_email_sent_at: {
      type: "timestamp",
      desc: "When the email saying sync ended was sent.",
    },
    before_email_sent_at: {
      type: "timestamp",
      desc: "When the email about two weeks before deletion was sent.",
    },
    email_cycle: {
      type: "uuid",
      desc: "The retention cycle the emails belong to: the request id of the accepted notice that ended sync. A later change starts a new cycle, and work for an older one is ignored.",
    },
    email_claim: {
      type: "uuid",
      desc: "The pass that holds the current retention step; every update of the step requires it, so a superseded pass changes nothing.",
    },
    email_due_at: {
      type: "timestamp",
      desc: "When the current retention step became due (for the overdue alert).",
    },
    last_error: {
      type: "string",
      desc: "Why the last notice or retention step failed: a failure code and HTTP status only, never a response body or exception text.",
    },
    notice_alerted_at: {
      type: "timestamp",
      desc: "When admins were alerted that the current notice is overdue; reset by each new notice.",
    },
    email_alerted_at: {
      type: "timestamp",
      desc: "When admins were alerted that the current retention step is overdue; reset by each new step and cycle.",
    },
  },
});

Table({
  name: "sagebrush_sync_emails",
  rules: {
    primary_key: "delivery_id",
    pg_indexes: ["account_id", "escalation_next_at"],
  },
  fields: {
    delivery_id: {
      type: "uuid",
      desc: "Derived from (cycle_id, stage), so each email of each retention cycle has exactly one delivery record.",
    },
    account_id: {
      type: "uuid",
      desc: "The account emailed.",
    },
    cycle_id: {
      type: "uuid",
      desc: "sagebrush_sync_states.email_cycle of the email.",
    },
    stage: {
      type: "string",
      pg_type: "varchar(16)",
      desc: "'ended' or 'before'.",
    },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      desc: "'pending' (to be sent), 'sending' (handed to the mail transport, outcome not yet recorded), 'sent', or 'unresolved' (the transport threw, or an attempt ended without a recorded outcome: the email may or may not have been delivered, and waits for an admin's decision).",
    },
    claim_id: {
      type: "uuid",
      desc: "The pass that admitted the current attempt.",
    },
    attempts: {
      type: "integer",
      desc: "Attempts handed to the mail transport.",
    },
    created: {
      type: "timestamp",
      desc: "When the record was created.",
    },
    admitted_at: {
      type: "timestamp",
      desc: "When the last attempt was handed to the mail transport.",
    },
    sent_at: {
      type: "timestamp",
      desc: "When the mail transport accepted the email (or an admin recorded it as delivered).",
    },
    escalation_next_at: {
      type: "timestamp",
      desc: "When the admins are next told about this unresolved email (at once, then daily; sooner again after a failed alert).",
    },
    escalation_attempts: {
      type: "integer",
      desc: "Failed alert attempts since the last recorded one.",
    },
    escalated_at: {
      type: "timestamp",
      desc: "When an alert about this unresolved email was last recorded.",
    },
    resolution: {
      type: "string",
      pg_type: "varchar(16)",
      desc: "An admin's decision about an unresolved email: 'delivered' or 'resend'.",
    },
    resolved_at: {
      type: "timestamp",
      desc: "When that decision was recorded.",
    },
  },
});
