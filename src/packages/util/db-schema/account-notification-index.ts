/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_notification_index",
  rules: {
    primary_key: ["account_id", "notification_id"],
    pg_indexes: ["project_id", "kind", "updated_at", "account_id, created_at"],
    user_query: {
      get: {
        pg_where: ["account_id"],
        options: [{ order_by: "-created_at" }, { limit: 2000 }],
        fields: {
          account_id: null,
          notification_id: null,
          kind: "",
          project_id: null,
          summary: {},
          read_state: {},
          created_at: null,
          updated_at: null,
        },
      },
    },
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account homed in this bay that receives this notification row.",
    },
    notification_id: {
      type: "uuid",
      desc: "Stable notification identifier within the account projection.",
    },
    kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Notification kind used by browser rendering logic.",
    },
    project_id: {
      type: "uuid",
      desc: "Optional related project id for project-scoped notifications.",
    },
    summary: {
      type: "map",
      desc: "Browser-facing summary payload for the notification row.",
    },
    read_state: {
      type: "map",
      desc: "Projected read/archive state for the notification row.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this notification entered the account projection.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this notification projection row was last updated.",
    },
  },
});
