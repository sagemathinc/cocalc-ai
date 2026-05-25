/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_ban_audit_log",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "actor_account_id", "action", "created"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          account_id: null,
          action: null,
          actor_account_id: null,
          reason: null,
          metadata: null,
          created: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique account ban audit event id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account affected by the ban or unban.",
      render: { type: "account" },
    },
    action: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Account ban audit action.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account that initiated the action, if any.",
      render: { type: "account" },
    },
    reason: {
      type: "string",
      desc: "Admin-entered reason for this action.",
    },
    metadata: {
      type: "map",
      desc: "Structured ban audit metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
  },
});
