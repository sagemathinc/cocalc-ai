/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

export type ProjectCollabInviteStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "blocked"
  | "expired"
  | "canceled";

Table({
  name: "project_collab_invites",
  fields: {
    invite_id: {
      type: "uuid",
      desc: "Unique invite id.",
    },
    project_id: {
      type: "uuid",
      desc: "Workspace id this invite is for.",
    },
    inviter_account_id: {
      type: "uuid",
      desc: "Account that created the invite.",
    },
    invitee_account_id: {
      type: "uuid",
      desc: "Account receiving the invite.",
    },
    invite_source: {
      type: "string",
      pg_type: "varchar(24)",
      desc: "Invite source: account, email, or course_email.",
    },
    accepted_account_id: {
      type: "uuid",
      desc: "Account that accepted an email-token invite.",
    },
    email_hash: {
      type: "string",
      desc: "HMAC of normalized target email for email-token invites.",
    },
    email_ciphertext: {
      type: "string",
      desc: "Encrypted target email for authorized resend/copy UI.",
    },
    token_hash: {
      type: "string",
      desc: "Hash of redemption token for email-token invites.",
    },
    token_ciphertext: {
      type: "string",
      desc: "Encrypted redemption token for authorized resend/copy UI.",
    },
    token_hint: {
      type: "string",
      pg_type: "varchar(16)",
      desc: "Short non-secret token suffix for support/debugging.",
    },
    last_sent: {
      type: "timestamp",
      desc: "When an email-token invite was last sent.",
    },
    resend_count: {
      type: "integer",
      desc: "Number of send attempts for an email-token invite.",
    },
    scope: {
      type: "string",
      pg_type: "varchar(48)",
      desc: "Invite scope such as project_collab or course_student.",
    },
    context: {
      type: "map",
      desc: "Structured context for scoped invites.",
    },
    invite_role: {
      type: "string",
      pg_type: "varchar(24)",
      desc: "Project user role granted if this invite is accepted: collaborator or viewer.",
    },
    read_policy: {
      type: "map",
      desc: "Viewer read policy to apply when invite_role is viewer.",
    },
    status: {
      type: "string",
      pg_type: "varchar(24)",
      desc: "Invite status: pending, accepted, declined, blocked, expired, or canceled.",
    },
    message: {
      type: "string",
      desc: "Optional short message from inviter.",
    },
    responder_action: {
      type: "string",
      pg_type: "varchar(24)",
      desc: "Most recent explicit response action by invitee.",
    },
    created: {
      type: "timestamp",
      desc: "When invite was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When invite was last updated.",
    },
    responded: {
      type: "timestamp",
      desc: "When invite was responded to.",
    },
  },
  rules: {
    primary_key: "invite_id",
    pg_indexes: [
      "project_id",
      "inviter_account_id",
      "invitee_account_id",
      "invite_source",
      "email_hash",
      "status",
      "created",
    ],
  },
});

Table({
  name: "project_collab_invite_blocks",
  fields: {
    blocker_account_id: {
      type: "uuid",
      desc: "Account that blocks incoming invites from blocked_account_id.",
    },
    blocked_account_id: {
      type: "uuid",
      desc: "Account that is blocked from inviting blocker_account_id.",
    },
    created: {
      type: "timestamp",
      desc: "When block was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When block was last updated.",
    },
  },
  rules: {
    primary_key: ["blocker_account_id", "blocked_account_id"],
    pg_indexes: ["blocked_account_id", "updated"],
  },
});
