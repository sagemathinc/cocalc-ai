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
          display_name: "",
          avatar_ref: null,
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
    display_name: {
      type: "string",
      desc: "Projected collaborator display name.",
    },
    avatar_ref: {
      type: "string",
      desc: "Optional projected avatar/image reference.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this collaborator projection row was last rebuilt or updated.",
    },
  },
});
