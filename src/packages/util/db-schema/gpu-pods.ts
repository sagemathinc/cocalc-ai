/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU bring-your-own-key: one row per pod CoCalc started with an account's
// own provider key, and an append-only log of what was done to it. Rows live
// on the key owner's home bay; nothing here holds a secret. Kept at least 13
// months, for attribution.
//
// Deliberately no user_query rules: clients read and change these only
// through the gpu.* hub API.

import { Table } from "./types";
import {
  GPU_ACTOR_KINDS,
  GPU_POD_ACTIONS,
  GPU_POD_BILLING_STATES,
  GPU_POD_DESIRED_STATES,
  GPU_POD_STATES,
} from "@cocalc/util/gpu/types";

function oneOf(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(",")}))`;
}

Table({
  name: "gpu_pods",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "key_owner_account_id",
      "beneficiary_account_id",
      "project_id",
      "approval_id",
      "state",
      "machine_id",
      "public_ip",
      // clearStaleHostkeyTokens
      "hostkey_expires",
      "hostkey_consumed_at",
      // the billing worker's queue
      "billing_state",
    ],
    pg_constraints: [
      {
        name: "gpu_pods_provider_pod",
        type: "unique",
        columns: ["provider", "provider_pod_id"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    handle: {
      type: "string",
      pg_type: "varchar(24)",
      not_null: true,
      unique: true,
      pg_check: "CHECK (handle ~ '^cc-[a-z2-7]{16}$')",
      desc: "Opaque pod name sent to the provider: cc- and 80 random bits in base32.",
    },
    key_owner_account_id: {
      type: "uuid",
      not_null: true,
      desc: "Account whose provider key launched (and is billed for) the pod.",
    },
    credential_id: {
      type: "uuid",
      not_null: true,
      desc: "external_credentials id of the key used.",
    },
    provider: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: "CHECK (provider IN ('runpod'))",
    },
    provider_pod_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "The provider's pod id, once known.",
    },
    beneficiary_account_id: {
      type: "uuid",
      not_null: true,
      desc: "Account responsible for the pod; set at launch, never changed. Under a project funding approval it is the acting account if one is known, else the payer (the key owner): a payer/responsibility field, never evidence of who acted (see actor_*).",
    },
    approval_id: {
      type: "uuid",
      desc: "The project funding approval that pays for the pod (its layer is gpu_budget_layers.approval_id); set at launch, never changed.",
    },
    actor_kind: {
      type: "string",
      pg_type: "varchar(16)",
      pg_check: "CHECK (actor_kind IN ('user','agent','project'))",
      desc: "Who launched it, from verified auth: a person, an agent, or the project itself (its terminal or code, which can't tell which collaborator acted). Null for pods from before this column.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "The verified acting account; null when the project itself launched it.",
    },
    actor_project_id: {
      type: "uuid",
      desc: "The project whose credential or agent launched it.",
    },
    project_id: { type: "uuid", desc: "Project the pod was launched for." },
    grant_id: { type: "uuid", desc: "Budget grant layer that funds it." },
    agent_id: { type: "string", pg_type: "varchar(128)" },
    turn_id: { type: "string", pg_type: "varchar(128)" },
    spec: {
      type: "map",
      not_null: true,
      desc: "The allowlisted launch spec; no secrets.",
    },
    gpu_type_id: { type: "string", pg_type: "varchar(64)", not_null: true },
    gpu_count: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (gpu_count BETWEEN 1 AND 8)",
    },
    cloud: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: "CHECK (cloud IN ('SECURE','COMMUNITY'))",
    },
    data_center_id: { type: "string", pg_type: "varchar(32)" },
    cost_per_hr: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      pg_check: "CHECK (cost_per_hr >= 0)",
    },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_POD_STATES),
    },
    desired_state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("desired_state", GPU_POD_DESIRED_STATES),
    },
    max_runtime_minutes: {
      type: "integer",
      not_null: true,
      pg_check: "CHECK (max_runtime_minutes > 0)",
    },
    deadline: {
      type: "timestamp",
      not_null: true,
      desc: "When the pod must be gone.",
    },
    reason: {
      type: "string",
      pg_type: "varchar(500)",
      desc: "Why it failed or was terminated, for the user.",
    },
    machine_id: { type: "string", pg_type: "varchar(64)" },
    public_ip: { type: "string", pg_type: "varchar(64)" },
    ports: { type: "map", desc: "Port mappings reported by the provider." },
    ssh_key_fingerprint: { type: "string", pg_type: "varchar(128)" },
    host_key_fingerprint: { type: "string", pg_type: "varchar(128)" },
    host_public_key: {
      type: "string",
      pg_type: "varchar(512)",
      desc: "The pod's SSH host public key, from its one-time registration.",
    },
    // The one-time host-key registration token (see server/gpu/hostkey.ts).
    // Only its verifier is stored. All four are cleared, with the host key,
    // when the pod leaves the registrable state.
    hostkey_token_id: {
      type: "uuid",
      unique: true,
      desc: "Id of the pod's one-time host-key registration token.",
    },
    hostkey_verifier: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "SHA-256 verifier of the registration token; never the token.",
    },
    hostkey_expires: { type: "timestamp" },
    hostkey_consumed_at: { type: "timestamp" },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated: { type: "timestamp", not_null: true, pg_default: "now()" },
    terminated_at: { type: "timestamp" },
    // the reaper's backoff for a failing step on this pod
    reap_after: { type: "timestamp" },
    // The reconciler's latest sighting of the pod at RunPod (a pass's
    // observed_at): a "not found" asked before it doesn't end the pod.
    provider_seen_at: { type: "timestamp" },
    // set by a forced key removal (5c): the key is gone, so CoCalc can no
    // longer reach the pod. Orthogonal to state (the pod may still run and
    // bill at RunPod); excluded from admission, slots and the reaper.
    unmanaged_at: { type: "timestamp" },
    reap_attempts: { type: "integer", not_null: true, pg_default: "0" },
    running_since: {
      type: "timestamp",
      desc: "When RunPod's pod was bound (runtime and cost start here).",
    },
    // Provider billing (5d-2a): one claim per pod (billing_next_at, claimed
    // before any provider call; billing_attempts drives the backoff), and
    // the result applied to every layer's reservation at once.
    billing_state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_default: "'estimated'",
      pg_check: oneOf("billing_state", GPU_POD_BILLING_STATES),
    },
    billing_next_at: { type: "timestamp" },
    billing_attempts: { type: "integer", not_null: true, pg_default: "0" },
    billed_at: { type: "timestamp" },
    billed_usd: { type: "string", pg_type: "NUMERIC(20,10)" },
  },
});

// Each pod's states over time (5d-2a), written with every state change in
// the same transaction (and opened when the pod is inserted): the observed
// state ledger that compute and disk spend are integrated over. One open
// interval per pod; an interval never ends before it starts.
Table({
  name: "gpu_pod_state_intervals",
  rules: {
    primary_key: "id",
    pg_indexes: ["pod_id", "key_owner_account_id"],
    pg_unique_indexes: ["(pod_id) WHERE ended IS NULL"],
    pg_constraints: [
      {
        name: "gpu_pod_state_intervals_order",
        type: "check",
        expression: "ended IS NULL OR ended >= started",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    pod_id: { type: "uuid", not_null: true },
    // the pod's key owner (rehome checks it, as for every GPU row)
    key_owner_account_id: { type: "uuid", not_null: true },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_POD_STATES),
    },
    // when the state began: the provider's time when trustworthy, else
    // when CoCalc observed it (never before the open interval's start)
    started: { type: "timestamp", not_null: true },
    ended: { type: "timestamp" },
  },
});

Table({
  name: "gpu_pod_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["pod_id", "at", "actor_account_id"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    pod_id: { type: "uuid", not_null: true },
    at: { type: "timestamp", not_null: true, pg_default: "now()" },
    actor_kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("actor_kind", GPU_ACTOR_KINDS),
    },
    actor_account_id: { type: "uuid" },
    // the project whose credential or agent acted (actor_kind 'project', or
    // an agent or person working under a project funding approval)
    actor_project_id: { type: "uuid" },
    agent_id: { type: "string", pg_type: "varchar(128)" },
    turn_id: {
      type: "string",
      pg_type: "varchar(128)",
      desc: "The agent run (turn) that did it, derived server-side like gpu_pods.turn_id; attribution only.",
    },
    action: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("action", GPU_POD_ACTIONS),
    },
    details: { type: "map", desc: "What happened; never a secret." },
  },
});
