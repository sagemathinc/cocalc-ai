/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_analytics_daily_counts",
  rules: {
    primary_key: [
      "snapshot_date",
      "bay_id",
      "membership_class",
      "source",
      "interval",
      "trial_status",
    ],
    pg_indexes: [
      "snapshot_date",
      "bay_id",
      "membership_class",
      "source",
      "interval",
      "trial_status",
    ],
  },
  fields: {
    snapshot_date: {
      type: "timestamp",
      pg_type: "date",
      desc: "UTC date represented by this daily membership count snapshot.",
    },
    bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Bay that produced this bay-local count snapshot.",
    },
    membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Membership tier id counted in this row.",
    },
    source: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Membership source category such as subscription, admin, grant, or free.",
    },
    interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Subscription billing interval for subscription rows, or none.",
    },
    trial_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Trial status classification for this count row.",
    },
    active_account_count: {
      type: "integer",
      desc: "Distinct active accounts represented by this row.",
    },
    subscription_count: {
      type: "integer",
      desc: "Live subscription count represented by this row, if applicable.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this snapshot row was first created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this snapshot row was last refreshed.",
    },
  },
});
