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
