/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_resource_quarantine_audit_log",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "actor_account_id", "created"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          account_id: null,
          actor_account_id: null,
          reason: null,
          result: null,
          created: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique account resource quarantine audit event id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account whose billing/resources were quarantined.",
      render: { type: "account" },
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account that initiated the quarantine, if any.",
      render: { type: "account" },
    },
    reason: {
      type: "string",
      desc: "Admin-entered reason for this quarantine.",
    },
    result: {
      type: "map",
      desc: "Structured result of the quarantine operation.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
  },
});
