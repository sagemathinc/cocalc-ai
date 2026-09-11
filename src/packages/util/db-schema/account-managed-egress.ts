/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

const NO_PROJECT_ID = "00000000-0000-0000-0000-000000000000";

Table({
  name: "account_managed_egress_events",
  rules: {
    primary_key: "id",
    pg_custom_indexes: [
      {
        name: "account_managed_egress_events_account_time_idx",
        query: "(account_id, occurred_at DESC)",
      },
      {
        name: "account_managed_egress_events_project_time_idx",
        query: "(project_id, occurred_at DESC)",
      },
      {
        name: "account_managed_egress_events_category_time_idx",
        query: "(category, occurred_at DESC)",
      },
      {
        name: "account_managed_egress_events_account_project_time_idx",
        query: "(account_id, project_id, occurred_at DESC)",
      },
      {
        name: "account_managed_egress_events_time_admin_idx",
        query:
          "(occurred_at DESC, id DESC) INCLUDE (account_id, project_id, category, bytes)",
      },
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Unique managed-egress event identifier." },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "Account-home authority for this usage event.",
    },
    project_id: {
      type: "uuid",
      not_null: false,
      desc: "Optional project that generated the managed egress.",
    },
    category: {
      type: "string",
      not_null: true,
      desc: "Managed-egress traffic category.",
    },
    bytes: {
      type: "integer",
      pg_type: "BIGINT",
      not_null: true,
      desc: "Number of bytes attributed to this event.",
    },
    metadata: {
      type: "map",
      desc: "Optional bounded diagnostic metadata for the event.",
    },
    occurred_at: {
      type: "timestamp",
      pg_type: "TIMESTAMP WITH TIME ZONE",
      pg_default: "now()",
      not_null: true,
      desc: "When the managed egress occurred.",
    },
  },
});

Table({
  name: "account_managed_egress_rollups",
  rules: {
    primary_key: ["bucket_start", "account_id", "project_id", "category"],
    pg_custom_indexes: [
      {
        name: "account_managed_egress_rollups_account_time_idx",
        query: "(account_id, bucket_start DESC)",
      },
      {
        name: "account_managed_egress_rollups_account_recent_idx",
        // Recent-event LIMIT queries must not sort an account's entire history.
        query: "(account_id, last_occurred_at DESC, bucket_start DESC)",
      },
      {
        name: "account_managed_egress_rollups_project_time_idx",
        query: "(project_id, bucket_start DESC)",
      },
      {
        name: "account_managed_egress_rollups_category_time_idx",
        query: "(category, bucket_start DESC)",
      },
      {
        name: "account_managed_egress_rollups_time_idx",
        query: "(bucket_start DESC)",
      },
      {
        name: "account_managed_egress_rollups_account_category_time_cover_idx",
        query: "(account_id, category, bucket_start DESC) INCLUDE (bytes)",
      },
    ],
  },
  fields: {
    bucket_start: {
      type: "timestamp",
      pg_type: "TIMESTAMP WITH TIME ZONE",
      not_null: true,
      desc: "Start of the one-minute UTC aggregation bucket.",
    },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "Account-home authority for this usage rollup.",
    },
    project_id: {
      type: "uuid",
      pg_default: `'${NO_PROJECT_ID}'::uuid`,
      not_null: true,
      desc: "Project attribution, or the nil UUID for account-only traffic.",
    },
    category: {
      type: "string",
      not_null: true,
      desc: "Managed-egress traffic category.",
    },
    bytes: {
      type: "integer",
      pg_type: "BIGINT",
      pg_default: "0",
      not_null: true,
      desc: "Total bytes in this bucket.",
    },
    event_count: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      desc: "Number of events represented by this bucket.",
    },
    first_occurred_at: {
      type: "timestamp",
      pg_type: "TIMESTAMP WITH TIME ZONE",
      not_null: true,
      desc: "Earliest event represented by this bucket.",
    },
    last_occurred_at: {
      type: "timestamp",
      pg_type: "TIMESTAMP WITH TIME ZONE",
      not_null: true,
      desc: "Latest event represented by this bucket.",
    },
    metadata_sample: {
      type: "map",
      desc: "Optional representative metadata from this bucket.",
    },
  },
});
