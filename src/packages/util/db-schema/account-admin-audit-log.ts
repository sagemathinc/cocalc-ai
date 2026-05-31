/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_admin_audit_log",
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
      desc: "Unique account admin-role audit event id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account affected by the admin-role action.",
      render: { type: "account" },
    },
    action: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Account admin-role audit action, e.g. grant-admin or revoke-admin.",
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
      desc: "Structured admin-role audit metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
  },
});
