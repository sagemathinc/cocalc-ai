/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_allocation_projections",
  rules: {
    primary_key: "fact_key",
    pg_indexes: ["projected_at"],
  },
  fields: {
    fact_key: {
      type: "string",
      pg_type: "VARCHAR(256)",
      desc: "Allocation fact that has been applied to the daily projection.",
    },
    projected_at: {
      type: "timestamp",
      desc: "When the fact was applied successfully.",
      not_null: true,
    },
  },
});
