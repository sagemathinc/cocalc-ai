/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_collaborator_index",
  rules: {
    primary_key: ["account_id", "collaborator_account_id"],
    pg_indexes: [
      "collaborator_account_id",
      "updated_at",
      "account_id, common_project_count",
    ],
    user_query: {
      get: {
        pg_where: ["account_id"],
        options: [{ order_by: "-common_project_count" }, { limit: 5000 }],
        fields: {
          account_id: null,
          collaborator_account_id: null,
          common_project_count: 0,
          first_name: "",
          last_name: "",
          name: "",
          last_active: null,
          profile: null,
          updated_at: null,
        },
      },
    },
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account homed in this bay that sees this collaborator summary.",
    },
    collaborator_account_id: {
      type: "uuid",
      desc: "Collaborator account referenced by the projection row.",
    },
    common_project_count: {
      type: "integer",
      desc: "Number of visible projects this account currently shares with the collaborator.",
    },
    first_name: {
      type: "string",
      desc: "Projected collaborator first name.",
    },
    last_name: {
      type: "string",
      desc: "Projected collaborator last name.",
    },
    name: {
      type: "string",
      desc: "Projected collaborator username/alias.",
    },
    last_active: {
      type: "timestamp",
      desc: "Projected collaborator last active timestamp.",
    },
    profile: {
      type: "map",
      desc: "Projected collaborator public profile.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this collaborator projection row was last rebuilt or updated.",
    },
  },
});
