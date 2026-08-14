/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_site_funded_usage",
  rules: {
    primary_key: "id",
    pg_indexes: ["resource_id", "owner_account_id", "project_id", "ended_at"],
    pg_unique_indexes: [
      "(resource_kind,resource_id,usage_kind,started_at,ended_at)",
    ],
  },
  fields: {
    id: { type: "uuid", desc: "Immutable internal usage interval." },
    resource_kind: { type: "string", desc: "vm or volume." },
    resource_id: { type: "uuid", desc: "Logical managed resource." },
    owner_account_id: { type: "uuid", desc: "Attribution owner." },
    project_id: { type: "uuid", desc: "Attached project when applicable." },
    provider: { type: "string", desc: "Cloud provider." },
    region: { type: "string", desc: "Provider region." },
    usage_kind: {
      type: "string",
      desc: "running, stopped, storage, or egress.",
    },
    quantity: { type: "number", desc: "Seconds or bytes in this interval." },
    unit: { type: "string", desc: "seconds or bytes." },
    provider_cost_usd: {
      type: "number",
      desc: "Estimated immutable provider cost.",
    },
    started_at: { type: "timestamp", desc: "Inclusive interval start." },
    ended_at: { type: "timestamp", desc: "Exclusive interval end." },
    metadata: {
      type: "map",
      desc: "Provider pricing and attribution snapshot.",
    },
    created_at: { type: "timestamp", desc: "Ledger insertion time." },
  },
});
