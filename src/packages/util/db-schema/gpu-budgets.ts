/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU bring-your-own-key budgets (step 5): per-key fences, budget layers,
// their events, and the reservation each pod holds on every layer that
// funds it. Rows live on the key owner's home bay, next to gpu_pods. RunPod
// money never touches CoCalc's ledger: these are limits CoCalc enforces on
// the account's own provider spend.
//
// Lock order everywhere (admission, settlement, reaper, drain, rehome):
// gpu_key_fences row, then gpu_budget_layers rows by id, then reservations
// and pods by id.
//
// Deliberately no user_query rules: only the gpu.* hub API changes these.

import { Table } from "./types";
import type { FieldSpec, Fields } from "./types";

export const GPU_FENCE_STATES = ["active", "draining", "compromised"] as const;
export const GPU_LAYER_KINDS = [
  "key",
  "course",
  "grant",
  "beneficiary",
  "project",
  "agent",
] as const;
export const GPU_LAYER_STATES = [
  "scheduled",
  "active",
  "suspended",
  "exhausted",
  "expired",
  "revoked",
  "closed",
] as const;
export const GPU_RESERVATION_STATES = [
  "active",
  "settled",
  "quarantined",
] as const;

function oneOf(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(",")}))`;
}

function usd(column: string, nullable = false): FieldSpec {
  return {
    type: "string",
    pg_type: "NUMERIC(20,10)",
    ...(nullable ? {} : { not_null: true, pg_default: "0" }),
    pg_check: `CHECK (${column} >= 0)`,
  };
}

function timestamps(): Fields {
  return {
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated: { type: "timestamp", not_null: true, pg_default: "now()" },
  };
}

Table({
  name: "gpu_key_fences",
  rules: { primary_key: "credential_id", pg_indexes: ["key_owner_account_id"] },
  fields: {
    credential_id: {
      type: "uuid",
      not_null: true,
      desc: "external_credentials id of the GPU provider key.",
    },
    key_owner_account_id: { type: "uuid", not_null: true },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_default: "'active'",
      pg_check: oneOf("state", GPU_FENCE_STATES),
      desc: "Only 'active' admits launches; draining/compromised are one-way.",
    },
    // Set by the reconciler (unknown pods, critical spend drift, a rejected
    // key); admission refuses while any is set.
    paused_reason: { type: "string", pg_type: "varchar(64)" },
    paused_at: { type: "timestamp" },
    // the owner's kill switch paused new launches (independent of the
    // safety pause above, which only its own alert lifts)
    kill_switch_at: { type: "timestamp" },
    // first seen without the gpu_provider_keys entitlement (the reaper
    // terminates its pods 7 days later); cleared when it returns
    entitlement_lapsed_at: { type: "timestamp" },
    ...timestamps(),
  },
});

Table({
  name: "gpu_budget_layers",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "credential_id",
      "key_owner_account_id",
      "parent_id",
      "beneficiary_account_id",
      "course_project_id",
    ],
    pg_constraints: [
      {
        name: "gpu_budget_layers_identity",
        type: "unique",
        columns: ["id", "credential_id", "key_owner_account_id", "scope_kind"],
      },
      // A child has the same key and owner as its parent, and a parent of
      // the right kind.
      {
        name: "gpu_budget_layers_parent",
        type: "foreign-key",
        columns: [
          "parent_id",
          "credential_id",
          "key_owner_account_id",
          "parent_scope_kind",
        ],
        references: {
          table: "gpu_budget_layers",
          columns: [
            "id",
            "credential_id",
            "key_owner_account_id",
            "scope_kind",
          ],
        },
      },
      {
        name: "gpu_budget_layers_fence",
        type: "foreign-key",
        columns: ["credential_id"],
        references: { table: "gpu_key_fences", columns: ["credential_id"] },
      },
      {
        name: "gpu_budget_layers_parent_kind",
        type: "check",
        expression: `(scope_kind = 'key' AND parent_id IS NULL AND parent_scope_kind IS NULL)
          OR (scope_kind = 'grant' AND parent_id IS NOT NULL AND parent_scope_kind = 'course')
          OR (scope_kind IN ('course','beneficiary','project','agent') AND parent_id IS NOT NULL AND parent_scope_kind = 'key')`,
      },
      {
        name: "gpu_budget_layers_binding",
        type: "check",
        expression: `(scope_kind = 'key' AND course_project_id IS NULL AND course_instance_id IS NULL AND beneficiary_account_id IS NULL AND project_id IS NULL AND agent_id IS NULL)
          OR (scope_kind = 'course' AND course_project_id IS NOT NULL AND course_instance_id IS NOT NULL AND beneficiary_account_id IS NULL AND project_id IS NULL AND agent_id IS NULL)
          OR (scope_kind = 'grant' AND course_project_id IS NOT NULL AND course_instance_id IS NOT NULL AND beneficiary_account_id IS NOT NULL AND project_id IS NULL AND agent_id IS NULL)
          OR (scope_kind = 'beneficiary' AND course_project_id IS NULL AND course_instance_id IS NULL AND beneficiary_account_id IS NOT NULL AND project_id IS NULL AND agent_id IS NULL)
          OR (scope_kind = 'project' AND course_project_id IS NULL AND course_instance_id IS NULL AND beneficiary_account_id IS NULL AND project_id IS NOT NULL AND agent_id IS NULL)
          OR (scope_kind = 'agent' AND course_project_id IS NULL AND course_instance_id IS NULL AND beneficiary_account_id IS NULL AND project_id IS NULL AND agent_id IS NOT NULL)`,
      },
      {
        name: "gpu_budget_layers_dates",
        type: "check",
        expression: "starts_at < ends_at",
      },
      {
        name: "gpu_budget_layers_authorized",
        type: "check",
        expression: "authorized_usd > 0",
      },
    ],
    // One key layer per key; one course layer per key and course instance;
    // one grant per student per course.
    pg_unique_indexes: [
      "(credential_id) WHERE scope_kind = 'key'",
      "(credential_id, course_instance_id) WHERE scope_kind = 'course'",
      "(parent_id, beneficiary_account_id) WHERE scope_kind = 'grant'",
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    credential_id: { type: "uuid", not_null: true },
    key_owner_account_id: {
      type: "uuid",
      not_null: true,
      desc: "From authentication, never a request body.",
    },
    scope_kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("scope_kind", GPU_LAYER_KINDS),
    },
    parent_id: { type: "uuid" },
    parent_scope_kind: {
      type: "string",
      pg_type: "varchar(16)",
      pg_check: oneOf("parent_scope_kind", GPU_LAYER_KINDS),
    },
    course_project_id: { type: "uuid" },
    course_instance_id: { type: "uuid" },
    beneficiary_account_id: { type: "uuid" },
    project_id: { type: "uuid" },
    agent_id: { type: "string", pg_type: "varchar(128)" },
    // Available = authorized - spent - reserved - released. released is
    // capacity deliberately retired, never a pod's unused estimate. spent
    // may exceed authorized (billing overrun): admission checks, the
    // database doesn't cap.
    authorized_usd: usd("authorized_usd"),
    spent_usd: usd("spent_usd"),
    reserved_usd: usd("reserved_usd"),
    released_usd: usd("released_usd"),
    allow_overcommit: {
      type: "boolean",
      not_null: true,
      pg_default: "false",
    },
    staff_may_manage: {
      type: "boolean",
      not_null: true,
      pg_default: "true",
    },
    max_hourly_usd: usd("max_hourly_usd", true),
    max_concurrent_pods: {
      type: "integer",
      pg_check: "CHECK (max_concurrent_pods >= 0)",
    },
    max_gpu_count: {
      type: "integer",
      pg_check: "CHECK (max_gpu_count >= 0)",
    },
    max_runtime_minutes: {
      type: "integer",
      pg_check: "CHECK (max_runtime_minutes >= 0)",
    },
    allowed_gpu_type_ids: { type: "array", pg_type: "TEXT[]" },
    allowed_data_center_ids: { type: "array", pg_type: "TEXT[]" },
    allowed_templates: { type: "array", pg_type: "TEXT[]" },
    cloud: {
      type: "string",
      pg_type: "varchar(16)",
      pg_check: "CHECK (cloud IN ('SECURE','COMMUNITY'))",
    },
    starts_at: { type: "timestamp", not_null: true },
    ends_at: { type: "timestamp", not_null: true },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_LAYER_STATES),
    },
    revoked_reason: {
      type: "string",
      pg_type: "varchar(32)",
      pg_check:
        "CHECK (revoked_reason IN ('owner','course_binding_lost','student_project_lost','key_cleanup','expired'))",
    },
    version: { type: "integer", not_null: true, pg_default: "1" },
    ...timestamps(),
  },
});

Table({
  name: "gpu_budget_events",
  rules: { primary_key: "id", pg_indexes: ["layer_id", "at"] },
  fields: {
    id: { type: "uuid", not_null: true },
    layer_id: { type: "uuid", not_null: true },
    at: { type: "timestamp", not_null: true, pg_default: "now()" },
    actor_account_id: { type: "uuid" },
    action: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check:
        "CHECK (action IN ('create','update','revoke','suspend','close'))",
    },
    // caps and amounts only
    before: { type: "map" },
    after: { type: "map" },
  },
});

Table({
  name: "gpu_pod_reservations",
  rules: {
    primary_key: "id",
    pg_indexes: ["pod_id", "layer_id", "state"],
    pg_constraints: [
      {
        name: "gpu_pod_reservations_pod_layer",
        type: "unique",
        columns: ["pod_id", "layer_id"],
      },
      {
        name: "gpu_pod_reservations_layer",
        type: "foreign-key",
        columns: ["layer_id"],
        references: { table: "gpu_budget_layers", columns: ["id"] },
      },
      {
        name: "gpu_pod_reservations_pod",
        type: "foreign-key",
        columns: ["pod_id"],
        references: { table: "gpu_pods", columns: ["id"] },
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    pod_id: { type: "uuid", not_null: true },
    layer_id: { type: "uuid", not_null: true },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_RESERVATION_STATES),
    },
    // the estimate held on the layer: hourly x runtime
    reserved_usd: usd("reserved_usd"),
    hourly_usd: usd("hourly_usd"),
    gpu_count: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (gpu_count >= 0)",
    },
    pod_slots: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      pg_check: "CHECK (pod_slots >= 0)",
    },
    // on settlement: the factual spend (may exceed the estimate); the unused
    // estimate, max(estimate - actual, 0); and the overrun,
    // max(actual - estimate, 0). spent = estimate - released + overrun.
    spent_usd: usd("spent_usd", true),
    released_usd: usd("released_usd", true),
    overrun_usd: usd("overrun_usd", true),
    settled_at: { type: "timestamp" },
    ...timestamps(),
  },
});

// One row per background GPU worker on this bay (the reaper; the reconciler
// in 5d): a lease so only one hub runs it, and the watermark of its last
// *completed* sweep, which launch admission requires to be recent.
Table({
  name: "gpu_worker_leases",
  rules: { primary_key: "name" },
  fields: {
    name: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: "CHECK (name IN ('reaper','reconciler'))",
    },
    holder: { type: "string", pg_type: "varchar(128)" },
    expires_at: { type: "timestamp" },
    last_started_at: { type: "timestamp" },
    last_completed_at: { type: "timestamp" },
    last_error: { type: "string", pg_type: "varchar(500)" },
  },
});

// An admin's explicit, scoped, time-limited permission to launch although a
// GPU worker is stale. It never bypasses a budget check.
Table({
  name: "gpu_worker_overrides",
  rules: {
    primary_key: "id",
    pg_indexes: ["key_owner_account_id", "expires_at"],
    pg_constraints: [
      {
        name: "gpu_worker_overrides_window",
        type: "check",
        expression:
          "expires_at > created AND expires_at <= created + interval '24 hours'",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    key_owner_account_id: { type: "uuid", not_null: true },
    admin_account_id: { type: "uuid", not_null: true },
    reason: {
      type: "string",
      pg_type: "varchar(500)",
      not_null: true,
      pg_check: "CHECK (length(btrim(reason)) >= 10)",
    },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    expires_at: { type: "timestamp", not_null: true },
    revoked_at: { type: "timestamp" },
  },
});
