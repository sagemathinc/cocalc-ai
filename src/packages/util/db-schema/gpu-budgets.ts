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

// closed: the key was removed (or its compromise cleanup finished); final
export const GPU_FENCE_STATES = [
  "active",
  "draining",
  "compromised",
  "closed",
] as const;
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
    // The reconciler (5d). last_inventory_at: when the listing of the last
    // complete inventory started (admission requires it fresh; it only moves
    // forward). next_reconcile_at: the attempt cursor, claimed before any
    // provider call (backoff after a failure); last_reconcile_attempt_at:
    // the observation whose outcome next_reconcile_at records (an older
    // pass never overwrites a newer one's).
    last_inventory_at: { type: "timestamp" },
    next_reconcile_at: { type: "timestamp" },
    last_reconcile_attempt_at: { type: "timestamp" },
    reconcile_attempts: { type: "integer", not_null: true, pg_default: "0" },
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
          OR (scope_kind = 'agent' AND course_project_id IS NULL AND course_instance_id IS NULL AND beneficiary_account_id IS NULL AND project_id IS NOT NULL AND agent_id IS NOT NULL)`,
      },
      // An agent layer is exactly one approved agent grant (step 6b); no
      // other layer has one.
      {
        name: "gpu_budget_layers_agent_grant",
        type: "check",
        expression: `(scope_kind = 'agent') = (grant_id IS NOT NULL)`,
      },
      {
        name: "gpu_budget_layers_dates",
        type: "check",
        expression: "starts_at < ends_at",
      },
      {
        name: "gpu_budget_layers_authorized",
        type: "check",
        // 0: a key that followed an exhausted one (5c) has nothing to spend
        // until its owner raises it
        expression: "authorized_usd >= 0",
      },
    ],
    // One key layer per key; one course layer per key and course instance;
    // one grant per student per course.
    pg_unique_indexes: [
      "(credential_id) WHERE scope_kind = 'key'",
      "(credential_id, course_instance_id) WHERE scope_kind = 'course'",
      "(parent_id, beneficiary_account_id) WHERE scope_kind = 'grant'",
      "(grant_id) WHERE scope_kind = 'agent'",
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
    // the gpu_agent_grants row an agent layer funds (step 6b)
    grant_id: { type: "uuid" },
    // When set, no new launch is admitted, but the layer stays active for its
    // running pods (an agent grant's run ended). A revoked layer's pods are
    // terminated by the reaper instead.
    admission_closed_at: { type: "timestamp" },
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

// A credential's security and audit log (step 5c): removal and forced
// removal, compromise and its cleanup (including RunPod pods CoCalc didn't
// start), the kill switch. Append-only; details are small and bounded
// (provider pod ids, sanitized names, counts), never provider payloads or
// secrets. Budget changes stay in gpu_budget_events.
export const GPU_KEY_EVENT_ACTIONS = [
  "removal_started",
  "removed",
  "forced_removal",
  "compromised",
  "unknown_pod_seen",
  "unknown_pod_terminated",
  "compromise_closed",
  "kill_switch",
  "resumed",
  "quarantine_released",
] as const;

Table({
  name: "gpu_key_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["credential_id", "key_owner_account_id", "at"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    credential_id: { type: "uuid", not_null: true },
    key_owner_account_id: { type: "uuid", not_null: true },
    at: { type: "timestamp", not_null: true, pg_default: "now()" },
    actor_kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check:
        "CHECK (actor_kind IN ('user','admin','reaper','cleanup','reconciler'))",
    },
    actor_account_id: { type: "uuid" },
    action: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: `CHECK (action IN (${GPU_KEY_EVENT_ACTIONS.map((a) => `'${a}'`).join(",")}))`,
    },
    details: { type: "map" },
  },
});

export const GPU_ALERT_KINDS = [
  "unknown_pod",
  "unmanaged_pod",
  "key_rejected",
  "quarantined_reservation",
  "compromise_awaiting_revocation",
  "compromise_check_pods",
  // 5d-2a: billing came in well above the estimate; billing never proved a
  // pod's lifetime within 48 h; billing pushed a layer past its authorization
  "spend_drift",
  "billing_missing",
  "over_budget",
  // 5d-2b, the provider account's own numbers (only for an account the
  // owner confirmed is theirs alone, for CoCalc only): RunPod's spend rate
  // or balance moved well beyond what CoCalc's pods explain; or the checks
  // are off because a second key on this bay uses the same RunPod account
  "account_spend_rate",
  "account_balance_drop",
  "account_checks_disabled",
  // 5d-2c: the key was decrypted with no authorized action behind it
  "unexplained_decrypt",
] as const;

// What CoCalc admins must know (5d-2), apart from any one owner's alerts.
export const GPU_ADMIN_ALERT_KINDS = [
  // a pod's layer reservations disagreed on its spend (billing not applied)
  "billing_inconsistent",
  // 5d-2c: a key decrypt without a matching authorization or outcome
  "unexplained_decrypt",
  "decrypt_unresolved",
] as const;
export const GPU_ALERT_SEVERITIES = ["info", "warning", "critical"] as const;

// What the owner must know about their key's RunPod account (5d). One open
// alert per (key, kind, dedupe_key); each kind has its own way to resolve
// (never "a listing didn't show it"), and some are only acknowledged.
Table({
  name: "gpu_alerts",
  rules: {
    primary_key: "id",
    pg_indexes: ["key_owner_account_id", "credential_id"],
    pg_unique_indexes: [
      "(credential_id, kind, dedupe_key) WHERE resolved_at IS NULL",
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    key_owner_account_id: { type: "uuid", not_null: true },
    credential_id: { type: "uuid", not_null: true },
    kind: {
      type: "string",
      pg_type: "varchar(40)",
      not_null: true,
      pg_check: oneOf("kind", GPU_ALERT_KINDS),
    },
    severity: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("severity", GPU_ALERT_SEVERITIES),
    },
    // e.g. the provider pod id (sanitized) or the reservation's pod id
    dedupe_key: { type: "string", pg_type: "varchar(128)", not_null: true },
    details: { type: "map" },
    opened: { type: "timestamp", not_null: true, pg_default: "now()" },
    // the observation that last saw the condition: a resolution only applies
    // if it observed later
    last_seen: { type: "timestamp", not_null: true, pg_default: "now()" },
    resolved_at: { type: "timestamp" },
    resolved_by: { type: "string", pg_type: "varchar(40)" },
    // the observation that resolved it (a pass's observed_at): a sighting
    // older than this doesn't reopen it
    resolved_observed_at: { type: "timestamp" },
    acknowledged_at: { type: "timestamp" },
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
      // compromise: the cleanup of keys reported compromised (5c), apart
      // from the reaper's sweep so it never holds back its watermark
      // billing: provider billing reconciliation (5d-2a)
      pg_check:
        "CHECK (name IN ('reaper','reconciler','compromise','billing','decrypt_audit'))",
    },
    holder: { type: "string", pg_type: "varchar(128)" },
    expires_at: { type: "timestamp" },
    last_started_at: { type: "timestamp" },
    last_completed_at: { type: "timestamp" },
    last_error: { type: "string", pg_type: "varchar(500)" },
    // the last complete sweep's numbers (the reconciler: its backlog)
    last_stats: { type: "map" },
  },
});

// The provider account watch (5d-2b): one row per provider account
// (identity), on the home bay of the owner who confirmed it is used only by
// them, only for CoCalc. The confirmation belongs to the key it was made with
// (credential_id): a new key starts unconfirmed. The samples are RunPod's
// balance and CoCalc's expected spend E (from gpu_pod_state_intervals) at the
// time RunPod was asked; a sample is written only if it is newer than the
// last one, under this row's lock.
Table({
  name: "gpu_provider_account_watch",
  rules: {
    primary_key: "id",
    pg_indexes: ["key_owner_account_id", "credential_id"],
    pg_unique_indexes: [
      "(provider, provider_account_kind, provider_account_id)",
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    provider: { type: "string", pg_type: "varchar(16)", not_null: true },
    provider_account_kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
    },
    provider_account_id: {
      type: "string",
      pg_type: "varchar(128)",
      not_null: true,
    },
    // who confirmed it, with which key, and when (null: not confirmed)
    key_owner_account_id: { type: "uuid", not_null: true },
    credential_id: { type: "uuid", not_null: true },
    confirmed_at: { type: "timestamp" },
    // a new id for each confirmation: a pass that started under an earlier
    // one (withdrawn meanwhile, and confirmed again) writes nothing
    confirmation_id: { type: "uuid" },
    // why the last pass didn't check (a second key on this account), or null
    disabled_reason: { type: "string", pg_type: "varchar(32)" },
    // consecutive passes over each spend-rate threshold
    rate_warning_passes: { type: "integer", not_null: true, pg_default: "0" },
    rate_critical_passes: { type: "integer", not_null: true, pg_default: "0" },
    // the last sample: when RunPod was asked, its balance, and E then
    last_asked_at: { type: "timestamp" },
    last_balance_usd: { type: "string", pg_type: "NUMERIC(20,10)" },
    last_expected_usd: { type: "string", pg_type: "NUMERIC(20,10)" },
    // the start of the current balance window (moved on a compare or deposit)
    baseline_at: { type: "timestamp" },
    baseline_balance_usd: { type: "string", pg_type: "NUMERIC(20,10)" },
    baseline_expected_usd: { type: "string", pg_type: "NUMERIC(20,10)" },
    updated: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

// Every run of a GPU worker (5d-2a): created in the transaction that takes
// its lease, closed in the one that releases or loses it. A worker's key use
// is tied to its run (5d-2c audits it).
Table({
  name: "gpu_worker_runs",
  rules: { primary_key: "id", pg_indexes: ["token", "name", "started"] },
  fields: {
    id: { type: "uuid", not_null: true },
    // the lease holder token of the sweep
    token: { type: "string", pg_type: "varchar(200)", not_null: true },
    name: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check:
        "CHECK (name IN ('reaper','reconciler','compromise','billing','decrypt_audit'))",
    },
    started: { type: "timestamp", not_null: true },
    finished: { type: "timestamp" },
    // finished | failed | lost
    outcome: { type: "string", pg_type: "varchar(16)" },
  },
});

// What CoCalc admins must know (5d-2): a durable row first (one open per
// kind and dedupe key), and email to admins as a retryable projection of it.
Table({
  name: "gpu_admin_alerts",
  rules: {
    primary_key: "id",
    pg_indexes: ["opened", "emailed_at"],
    pg_unique_indexes: ["(kind, dedupe_key) WHERE resolved_at IS NULL"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    kind: {
      type: "string",
      pg_type: "varchar(40)",
      not_null: true,
      pg_check: oneOf("kind", GPU_ADMIN_ALERT_KINDS),
    },
    severity: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("severity", GPU_ALERT_SEVERITIES),
    },
    dedupe_key: { type: "string", pg_type: "varchar(128)", not_null: true },
    // the account and key it concerns, if any (never key material)
    key_owner_account_id: { type: "uuid" },
    credential_id: { type: "uuid" },
    details: { type: "map" },
    opened: { type: "timestamp", not_null: true, pg_default: "now()" },
    last_seen: { type: "timestamp", not_null: true, pg_default: "now()" },
    resolved_at: { type: "timestamp" },
    resolved_by: { type: "string", pg_type: "varchar(40)" },
    emailed_at: { type: "timestamp" },
    email_attempts: { type: "integer", not_null: true, pg_default: "0" },
    // the admins it was emailed to (a retry skips them)
    emailed_to: { type: "array", pg_type: "TEXT[]" },
    // the hub sending its email now (one at a time, across hubs)
    email_claim: { type: "string", pg_type: "varchar(64)" },
    email_claimed_until: { type: "timestamp" },
    // after a failed attempt, not retried before this (null: due now)
    email_next_at: { type: "timestamp" },
  },
});

// Why a provider key is decrypted (5d-2c). A user or agent action's
// purposes, then a worker run's (5d-2b's account checks take a decrypt of
// their own, in the reconciler's run).
export const GPU_KEY_USE_PURPOSES = [
  "launch",
  "terminate",
  "pod_read",
  "ssh_info",
  // the GPU catalog and availability, read with the owner's key
  "catalog",
  "verify",
  "removal",
  "compromise",
] as const;
export const GPU_KEY_WORKER_PURPOSES = [
  "reaper",
  "cleanup",
  "reconcile",
  "account_watch",
  "billing",
] as const;
export const GPU_KEY_DECRYPT_PURPOSES = [
  ...GPU_KEY_USE_PURPOSES,
  ...GPU_KEY_WORKER_PURPOSES,
] as const;
// what admitted a user or agent action, fixed when its record is made
export const GPU_KEY_USE_RULES = ["owner", "beneficiary", "agent"] as const;
export const GPU_KEY_USE_OUTCOMES = ["succeeded", "failed", "unknown"] as const;

// The authorization record of one user or agent action on a provider key
// (5d-2c): made by the home bay's entry point from the verified caller,
// before any decrypt, and never changed after, except its counter. Its id
// (128 random bits) is the capability the action presents to decrypt.
Table({
  name: "gpu_key_uses",
  rules: {
    primary_key: "id",
    pg_indexes: ["key_owner_account_id", "created", "audited_at"],
  },
  fields: {
    id: { type: "string", pg_type: "varchar(32)", not_null: true },
    key_owner_account_id: { type: "uuid", not_null: true },
    // the owner's key when the record was made (null: none connected)
    credential_id: { type: "uuid" },
    principal_account_id: { type: "uuid", not_null: true },
    // an agent's verified principal (null for a person)
    agent_project_id: { type: "uuid" },
    agent_id: { type: "string", pg_type: "varchar(200)" },
    agent_run_id: { type: "string", pg_type: "varchar(200)" },
    purpose: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("purpose", GPU_KEY_USE_PURPOSES),
    },
    authorized: { type: "boolean", not_null: true },
    rule: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("rule", GPU_KEY_USE_RULES),
    },
    // what the rule refers to (the pod a beneficiary acts on), if anything
    rule_ref: { type: "string", pg_type: "varchar(200)" },
    request_id: { type: "string", pg_type: "varchar(200)" },
    bay_id: { type: "string", pg_type: "varchar(200)", not_null: true },
    created: { type: "timestamp", not_null: true },
    expires: { type: "timestamp", not_null: true },
    max_decrypts: { type: "integer", not_null: true },
    decrypts: { type: "integer", not_null: true, pg_default: "0" },
    // set by the decrypt audit (5d-2c-2) once it has covered this record
    audited_at: { type: "timestamp" },
  },
});

// What a user or agent write came to, recorded once in a finally (5d-2c):
// an attempt that was made explains its decrypt, whatever it did.
Table({
  name: "gpu_key_use_outcomes",
  rules: { primary_key: "key_use_id" },
  fields: {
    key_use_id: { type: "string", pg_type: "varchar(32)", not_null: true },
    outcome: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("outcome", GPU_KEY_USE_OUTCOMES),
    },
    at: { type: "timestamp", not_null: true },
  },
});

// Every decrypt of a provider key (5d-2c): inserted, with its outbox row, in
// the transaction that validated its capability, before the key is read; the
// broker then claims it once, decrypts, and records how it finished. Never
// key material.
Table({
  name: "gpu_key_decrypts",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "key_use_id",
      "worker_run_id",
      "credential_id",
      "started",
      "audited_at",
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    // the capability presented: a key use's record, or a worker's run
    key_use_id: { type: "string", pg_type: "varchar(32)" },
    worker_run_id: { type: "uuid" },
    worker_name: { type: "string", pg_type: "varchar(32)" },
    purpose: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("purpose", GPU_KEY_DECRYPT_PURPOSES),
    },
    key_owner_account_id: { type: "uuid", not_null: true },
    credential_id: { type: "uuid", not_null: true },
    // the account (a person's or an agent's) or the worker it is for
    principal: { type: "string", pg_type: "varchar(200)", not_null: true },
    bay_id: { type: "string", pg_type: "varchar(200)", not_null: true },
    // the hub process (host and pid)
    process: { type: "string", pg_type: "varchar(200)", not_null: true },
    started: { type: "timestamp", not_null: true },
    // the broker's one-shot permit
    claimed_at: { type: "timestamp" },
    claim_nonce: { type: "string", pg_type: "varchar(64)" },
    finished: { type: "timestamp" },
    // ok | error | no_key
    outcome: { type: "string", pg_type: "varchar(16)" },
    // the decrypt audit's verdict (5d-2c-2): explained | unexplained |
    // unresolved | admitted_unused
    verdict: { type: "string", pg_type: "varchar(16)" },
    audited_at: { type: "timestamp" },
  },
});

// Security events waiting for the off-host log (5d-2c): written with the
// event, acked by the future consumer after its own durable write. Nothing
// here is off-host yet.
Table({
  name: "security_event_outbox",
  rules: { primary_key: "id", pg_indexes: ["created", "acked_at"] },
  fields: {
    id: { type: "uuid", not_null: true },
    kind: { type: "string", pg_type: "varchar(64)", not_null: true },
    details: { type: "map", not_null: true },
    created: { type: "timestamp", not_null: true },
    acked_at: { type: "timestamp" },
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
