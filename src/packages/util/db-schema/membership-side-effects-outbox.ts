/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_side_effects_outbox",
  rules: {
    primary_key: "effect_key",
    pg_indexes: [
      "owner_account_id",
      "package_id",
      "assignment_id",
      "effect_kind",
      "desired_revision",
      "applied_revision",
      "next_attempt_at",
      "lease_expires_at",
      "updated_at",
      "completed_at",
    ],
  },
  fields: {
    effect_key: {
      type: "string",
      pg_type: "VARCHAR(192)",
      desc: "Stable desired-state key for a remote membership side effect.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Account whose home bay owns the authoritative package assignment state.",
      render: { type: "account" },
    },
    package_id: {
      type: "uuid",
      desc: "Membership package whose assignment state produced this side effect.",
    },
    assignment_id: {
      type: "uuid",
      desc: "Assignment whose remote side effect should converge.",
    },
    effect_kind: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Desired side-effect kind such as grant-sync or project-usage-sync.",
    },
    desired_payload_json: {
      type: "map",
      desc: "Latest desired remote state for this effect key.",
    },
    desired_revision: {
      type: "number",
      desc: "Monotone desired-state revision incremented on each authoritative update.",
    },
    applied_revision: {
      type: "number",
      desc: "Highest desired revision that has been successfully applied so far.",
    },
    next_attempt_at: {
      type: "timestamp",
      desc: "Earliest time when the maintenance worker should retry this effect.",
    },
    lease_expires_at: {
      type: "timestamp",
      desc: "Worker lease deadline used to avoid duplicate concurrent processing.",
    },
    last_attempt_at: {
      type: "timestamp",
      desc: "When a worker most recently attempted to apply this effect.",
    },
    last_error: {
      type: "string",
      desc: "Latest replay error message, if any.",
    },
    attempt_count: {
      type: "number",
      desc: "How many replay attempts have been made for this effect key.",
    },
    created_at: {
      type: "timestamp",
      desc: "When the durable desired-state row was first created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When the desired payload or worker metadata last changed.",
    },
    completed_at: {
      type: "timestamp",
      desc: "When the latest desired revision became fully applied, if any.",
    },
  },
});
