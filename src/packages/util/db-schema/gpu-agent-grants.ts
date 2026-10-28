/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// GPU bring-your-own-key, step 6b: an agent's GPU launch needs its human's
// approval of the exact launch, for one agent run.
//
// - gpu_agent_requests: what an agent asked for. The payload is immutable:
//   a different launch is a new row (the older pending one is superseded),
//   and approval names a request id and its payload hash, so the human
//   approves exactly what they saw.
// - gpu_agent_grants: an approved request. It authorizes new launches only
//   during that run (account, project, agent, run, all from verified auth)
//   and is funded by exactly one agent budget layer (gpu_budget_layers.
//   grant_id). Expiry closes admission on the layer; an explicit revoke also
//   revokes the layer, whose pods the reaper then terminates.
//
// Rows live on the key owner's home bay, next to gpu_pods and the layers.
// Deliberately no user_query rules: only the gpu.* hub API changes these.

import { Table } from "./types";

export const GPU_AGENT_REQUEST_STATES = [
  "pending",
  "approved",
  "superseded",
  "expired",
  "denied",
] as const;

export const GPU_AGENT_GRANT_STATES = ["active", "expired", "revoked"] as const;

function oneOf(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(",")}))`;
}

const identity = {
  account_id: {
    type: "uuid",
    not_null: true,
    desc: "The human the agent acts for (verified auth, never a request body).",
  },
  project_id: {
    type: "uuid",
    not_null: true,
    desc: "The agent's bound project (verified auth).",
  },
  agent_id: {
    type: "string",
    pg_type: "varchar(128)",
    not_null: true,
    desc: "The agent (verified auth).",
  },
  run_id: {
    type: "string",
    pg_type: "varchar(128)",
    not_null: true,
    desc: "The agent run (turn) the request was made in (verified auth).",
  },
} as const;

Table({
  name: "gpu_agent_requests",
  rules: {
    primary_key: "request_id",
    pg_indexes: ["account_id", "project_id", "expires_at"],
  },
  fields: {
    request_id: { type: "uuid", not_null: true },
    ...identity,
    operation_id: {
      type: "string",
      pg_type: "varchar(128)",
      not_null: true,
      desc: "The agent's idempotency key for this launch.",
    },
    payload: {
      type: "map",
      not_null: true,
      desc: "The canonical launch the human is asked to approve; never changed.",
    },
    payload_hash: {
      type: "string",
      pg_type: "char(64)",
      not_null: true,
      desc: "SHA-256 of the versioned canonical payload.",
    },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_AGENT_REQUEST_STATES),
    },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    expires_at: { type: "timestamp", not_null: true },
    decided_at: { type: "timestamp" },
    decided_by_account_id: { type: "uuid" },
  },
});

Table({
  name: "gpu_agent_grants",
  rules: {
    primary_key: "grant_id",
    pg_indexes: ["account_id", "project_id", "expires_at"],
    pg_unique_indexes: ["(request_id)", "(layer_id)"],
    pg_constraints: [
      {
        name: "gpu_agent_grants_launches",
        type: "check",
        expression: "launches_used >= 0 AND launches_used <= launches_allowed",
      },
    ],
  },
  fields: {
    grant_id: { type: "uuid", not_null: true },
    request_id: { type: "uuid", not_null: true },
    ...identity,
    operation_id: {
      type: "string",
      pg_type: "varchar(128)",
      not_null: true,
    },
    payload_hash: {
      type: "string",
      pg_type: "char(64)",
      not_null: true,
      desc: "The approved request's hash: a launch must match it exactly.",
    },
    credential_id: {
      type: "uuid",
      not_null: true,
      desc: "The key the approved launch runs on.",
    },
    layer_id: {
      type: "uuid",
      not_null: true,
      desc: "The agent budget layer that funds it.",
    },
    launches_allowed: {
      type: "integer",
      not_null: true,
      pg_default: "1",
    },
    launches_used: { type: "integer", not_null: true, pg_default: "0" },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", GPU_AGENT_GRANT_STATES),
    },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    expires_at: {
      type: "timestamp",
      not_null: true,
      desc: "No new launch after this (no later than the run's token).",
    },
    revoked_at: { type: "timestamp" },
    revoked_by_account_id: { type: "uuid" },
  },
});
