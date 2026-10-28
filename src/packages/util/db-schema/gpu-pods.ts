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
      "state",
      "machine_id",
      "public_ip",
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
      pg_type: "varchar(16)",
      not_null: true,
      unique: true,
      pg_check: "CHECK (handle ~ '^cc-[a-z2-7]{8}$')",
      desc: "Opaque pod name sent to the provider, e.g. cc-7f3k9q2x.",
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
      desc: "Account responsible for the pod; set at launch, never changed.",
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
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated: { type: "timestamp", not_null: true, pg_default: "now()" },
    terminated_at: { type: "timestamp" },
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
    agent_id: { type: "string", pg_type: "varchar(128)" },
    action: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("action", GPU_POD_ACTIONS),
    },
    details: { type: "map", desc: "What happened; never a secret." },
  },
});
