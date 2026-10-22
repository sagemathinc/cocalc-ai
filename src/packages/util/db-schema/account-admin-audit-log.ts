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
    pg_custom_indexes: [
      {
        // At most one after-the-fact attribution per admin balance adjustment
        // (server/purchases/admin-credit-attribution.ts).
        name: "account_admin_audit_log_attribution_purchase_unique",
        unique: true,
        query:
          "((metadata->>'purchase_id')) WHERE action = 'balance-adjustment-attribution'",
      },
    ],
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
      desc: "Unique account admin action audit event id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account affected by the admin action.",
      render: { type: "account" },
    },
    action: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Account admin audit action, e.g. grant-admin, revoke-admin, or balance-adjustment.",
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
