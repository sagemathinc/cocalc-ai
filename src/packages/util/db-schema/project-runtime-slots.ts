/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_runtime_slots",
  rules: {
    primary_key: ["sponsor_account_id", "project_id"],
    pg_indexes: [
      "sponsor_account_id",
      "project_id",
      "owning_bay_id",
      "host_id",
      "state",
      "expires_at",
      "(sponsor_account_id, state)",
    ],
  },
  fields: {
    sponsor_account_id: {
      type: "uuid",
      desc: "Account whose membership sponsors this runtime slot.",
      render: { type: "account" },
    },
    project_id: {
      type: "uuid",
      desc: "Project consuming this runtime slot.",
      render: { type: "project_link" },
    },
    owning_bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Control-plane bay that owns the project.",
    },
    host_id: {
      type: "uuid",
      desc: "Project host currently running or starting the project.",
    },
    state: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Runtime slot state: starting, running, released, expired, or failed.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Account whose action acquired or refreshed this slot.",
      render: { type: "account" },
    },
    reason: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Human-readable reason for acquiring this slot.",
    },
    acquired_at: {
      type: "timestamp",
      desc: "When this slot was first acquired.",
    },
    heartbeat_at: {
      type: "timestamp",
      desc: "When this slot was last refreshed.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this slot may be treated as stale and expired.",
    },
    op_id: {
      type: "uuid",
      desc: "Optional long-running-operation id associated with this start.",
    },
    metadata: {
      type: "map",
      desc: "Additional runtime-slot metadata for diagnostics.",
    },
  },
});
