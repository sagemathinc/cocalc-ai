/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// Aggregate counts for the public Home page experiment
// (util/public-home-experiment.ts): no visitor or account is identified.
Table({
  name: "public_home_experiment_counts",
  rules: {
    primary_key: ["day", "variant", "event"],
    pg_indexes: ["day"],
  },
  fields: {
    day: {
      type: "timestamp",
      pg_type: "date",
      desc: "UTC day of the counted events.",
    },
    variant: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Home page version id.",
    },
    event: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "view, cta (sign-up page opened from that version) or signup.",
    },
    count: {
      type: "integer",
      pg_type: "BIGINT",
      desc: "Number of events that day.",
    },
  },
});
