/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { FieldSpec, Fields } from "./types";

Table({
  name: "compute_funding_exposure_policy",
  rules: { primary_key: "bay_id" },
  fields: {
    bay_id: { type: "string", not_null: true },
    allocation: { type: "map", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

function amount(column: string): FieldSpec {
  return {
    type: "string",
    pg_type: "NUMERIC(20,10)",
    not_null: true,
    pg_default: "0",
    pg_check: `CHECK (${column} >= 0 AND ${column} < 10000000000)`,
  };
}
function timestamps(): Fields {
  return {
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  };
}

Table({
  name: "compute_vm_personal_consents",
  rules: {
    primary_key: "id",
    pg_indexes: ["payer_account_id", "vm_id"],
    pg_constraints: [
      {
        name: "compute_vm_personal_consents_operation",
        type: "unique",
        columns: ["payer_account_id", "operation_id"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    vm_id: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    terms: { type: "map", not_null: true },
    review: { type: "map", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (state IN ('pending','approved','preparing','active','cancelled','expired','exhausted','rejected'))",
    },
    version: { type: "integer", not_null: true, pg_default: "1" },
    spent_usd: amount("spent_usd"),
    committed_usd: amount("committed_usd"),
    approval_url: { type: "string", not_null: true },
    approval_expires_at: { type: "timestamp", not_null: true },
    activated_at: { type: "timestamp" },
    cleared_operation_id: { type: "uuid" },
    handoff_operation_id: { type: "uuid" },
    handoff: { type: "map" },
    ...timestamps(),
  },
});

// Payer-home only. No user_query rules expose financial writes.
Table({
  name: "compute_funding_reservations",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "payer_account_id",
      "pool_id",
      "grant_id",
      "resource_id",
      "authorized_until",
      "state",
    ],
    pg_constraints: [
      {
        name: "compute_funding_reservations_budget",
        type: "check",
        expression:
          "authorized_usd > 0 AND spent_usd + released_usd <= authorized_usd AND protected_usd <= authorized_usd - spent_usd - released_usd",
      },
      {
        name: "compute_funding_reservations_operation",
        type: "unique",
        columns: ["payer_account_id", "operation_id"],
      },
      {
        name: "compute_funding_reservations_owner",
        type: "unique",
        columns: ["id", "payer_account_id"],
      },
      {
        name: "compute_funding_reservations_grant",
        type: "foreign-key",
        columns: ["grant_id", "pool_id"],
        references: {
          table: "compute_funding_grants",
          columns: ["id", "pool_id"],
        },
      },
      {
        name: "compute_funding_reservations_payer",
        type: "foreign-key",
        columns: ["pool_id", "payer_account_id"],
        references: {
          table: "compute_funding_pools",
          columns: ["id", "payer_account_id"],
        },
      },
      {
        name: "compute_funding_reservations_settled",
        type: "check",
        expression:
          "state <> 'settled' OR spent_usd + released_usd = authorized_usd",
      },
      {
        name: "compute_funding_reservations_source",
        type: "check",
        expression:
          "(pool_id IS NOT NULL AND grant_id IS NOT NULL AND personal_hold_id IS NULL AND personal_lane IS NULL) OR (pool_id IS NULL AND grant_id IS NULL AND personal_hold_id IS NOT NULL AND personal_lane IS NOT NULL)",
      },
      {
        name: "compute_funding_reservations_personal_hold",
        type: "foreign-key",
        columns: ["personal_hold_id", "payer_account_id", "personal_lane"],
        references: {
          table: "account_funding_holds",
          columns: ["id", "payer_account_id", "lane"],
        },
      },
      {
        name: "compute_funding_reservations_personal_source",
        type: "unique",
        columns: ["personal_hold_id"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    pool_id: { type: "uuid", not_null: false },
    grant_id: { type: "uuid", not_null: false },
    personal_hold_id: { type: "uuid" },
    personal_lane: {
      type: "string",
      pg_check: "CHECK (personal_lane IN ('prepaid', 'postpaid'))",
    },
    resource_id: { type: "uuid", not_null: true },
    resource_generation: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (resource_generation > 0)",
    },
    resource_kind: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (resource_kind IN ('compute-vm', 'compute-volume'))",
    },
    funding_epoch: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    request_hash: { type: "string", not_null: true },
    pricing_snapshot: { type: "map", not_null: true },
    authorized_usd: amount("authorized_usd"),
    spent_usd: amount("spent_usd"),
    released_usd: amount("released_usd"),
    protected_usd: amount("protected_usd"),
    authorized_until: { type: "timestamp", not_null: true },
    usage_window_5h_id: { type: "uuid" },
    usage_window_7d_id: { type: "uuid" },
    dispatched_at: { type: "timestamp" },
    state: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (state IN ('reserved', 'dispatched', 'consuming', 'uncertain', 'settling', 'settled'))",
    },
    ...timestamps(),
  },
});

// Immutable operation receipts also form the durable source for projections.
// Delivery state belongs in a separate outbox, never in these financial facts.
Table({
  name: "compute_funding_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["payer_account_id", "reservation_id", "created_at"],
    pg_constraints: [
      {
        name: "compute_funding_events_operation",
        type: "unique",
        columns: ["payer_account_id", "operation_id"],
      },
      {
        name: "compute_funding_events_reservation",
        type: "foreign-key",
        columns: ["reservation_id", "payer_account_id"],
        references: {
          table: "compute_funding_reservations",
          columns: ["id", "payer_account_id"],
        },
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    reservation_id: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    request_hash: { type: "string", not_null: true },
    kind: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (kind IN ('reserved', 'dispatched', 'uncertain', 'canceled-before-dispatch', 'charged', 'renewed'))",
    },
    details: { type: "map", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "compute_funding_purchase_attributions",
  rules: {
    primary_key: "purchase_id",
    pg_indexes: ["payer_account_id", "reservation_id", "ended_at"],
    pg_constraints: [
      {
        name: "compute_funding_purchase_attributions_operation",
        type: "unique",
        columns: ["payer_account_id", "operation_id"],
      },
      {
        name: "compute_funding_purchase_attributions_reservation",
        type: "foreign-key",
        columns: ["reservation_id", "payer_account_id"],
        references: {
          table: "compute_funding_reservations",
          columns: ["id", "payer_account_id"],
        },
      },
      {
        name: "compute_funding_purchase_attributions_purchase",
        type: "foreign-key",
        columns: ["purchase_id"],
        references: { table: "purchases", columns: ["id"] },
      },
      {
        name: "compute_funding_purchase_attributions_interval",
        type: "check",
        expression: "started_at < ended_at",
      },
      {
        name: "compute_funding_purchase_attributions_rounding",
        type: "check",
        expression: "charged_usd = ROUND(exact_cost_usd, 2)",
      },
    ],
  },
  fields: {
    purchase_id: { type: "integer", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    reservation_id: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    request_hash: { type: "string", not_null: true },
    started_at: { type: "timestamp", not_null: true },
    ended_at: { type: "timestamp", not_null: true },
    exact_cost_usd: amount("exact_cost_usd"),
    charged_usd: amount("charged_usd"),
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});
