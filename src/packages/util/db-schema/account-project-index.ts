/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_project_index",
  rules: {
    primary_key: ["account_id", "project_id"],
    pg_indexes: [
      "project_id",
      "host_id",
      "owning_bay_id",
      "is_hidden",
      "updated_at",
      "account_id, sort_key",
    ],
    user_query: {
      get: {
        pg_where: [{ "account_id = $::UUID": "account_id" }],
        options: [{ order_by: "-sort_key" }, { limit: 2000 }],
        fields: {
          account_id: null,
          project_id: null,
          owning_bay_id: null,
          host_id: null,
          title: "",
          description: "",
          theme: null,
          users_summary: {},
          state_summary: {},
          last_activity_at: null,
          last_opened_at: null,
          is_hidden: false,
          sort_key: null,
          updated_at: null,
        },
      },
    },
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account homed in this bay that sees this projected project summary.",
    },
    project_id: {
      type: "uuid",
      desc: "Projected project id visible to the account.",
    },
    owning_bay_id: {
      type: "string",
      desc: "Bay that authoritatively owns this project.",
    },
    host_id: {
      type: "uuid",
      desc: "Current assigned host for the project, if any.",
    },
    title: {
      type: "string",
      desc: "Projected project title for list views.",
    },
    description: {
      type: "string",
      desc: "Projected project description for list views.",
    },
    theme: {
      type: "map",
      desc: "Projected project appearance theme for list, nav, and search views.",
    },
    users_summary: {
      type: "map",
      desc: "Browser-facing summary of project membership for this account.",
    },
    state_summary: {
      type: "map",
      desc: "Browser-facing summary of current project runtime state.",
    },
    last_activity_at: {
      type: "timestamp",
      desc: "Most recent activity timestamp used for display and sorting.",
    },
    last_opened_at: {
      type: "timestamp",
      desc: "Most recent browser open timestamp tracked by the home bay.",
    },
    is_hidden: {
      type: "boolean",
      desc: "Whether this account has hidden the project in list views.",
    },
    sort_key: {
      type: "timestamp",
      desc: "Primary sort key for browser project-list ordering.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this projected row was last rebuilt or updated.",
    },
  },
});
