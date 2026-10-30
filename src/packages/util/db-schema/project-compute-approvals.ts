/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Project funding approvals for bring-your-own-key compute (PROJECT_FUNDING.md
// in the RunPod working notes): a collaborator lets work in one project spend
// their own provider key, up to an amount, until a time.
//
// - project_compute_approvals: on the project's owning bay. Requests (no
//   funder yet) and the routing record of each approval. A projection, never
//   the money authority: the funder's home bay holds the approval's budget
//   layer (gpu_budget_layers, scope_kind 'project', approval_id), and every
//   launch is admitted there against exactly that layer.
// - project_funding_outbox: ordered, versioned messages between the two bays
//   (activate, update, end, pod counts), retried until the receiver has
//   committed them.
//
// Deliberately no user_query rules: only the gpu.* hub and inter-bay APIs
// change these.

import { Table } from "./types";

export const PROJECT_COMPUTE_PROVIDERS = ["runpod"] as const;
export const PROJECT_COMPUTE_ROW_KINDS = ["request", "approval"] as const;
// request: pending -> approved | dismissed | expired | superseded
// approval: pending -> active -> ended, or pending -> ended (ended is final)
export const PROJECT_COMPUTE_ROW_STATES = [
  "pending",
  "active",
  "ended",
  "approved",
  "dismissed",
  "expired",
  "superseded",
] as const;
export const PROJECT_COMPUTE_ENDED_REASONS = [
  "revoked",
  "expired",
  "lease_expired",
  "activation_failed",
  "funder_left_project",
  "project_deleted",
  "key_cleanup",
] as const;
export const PROJECT_COMPUTE_ACTOR_KINDS = [
  "project",
  "user",
  "agent",
] as const;
export const PROJECT_FUNDING_MESSAGE_KINDS = [
  "activate",
  "update",
  "end",
  "pods",
] as const;

function oneOf(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${values.map((v) => `'${v}'`).join(",")}))`;
}

Table({
  name: "project_compute_approvals",
  rules: {
    primary_key: "id",
    pg_indexes: ["project_id", "funder_account_id", "lease_expires_at"],
    pg_constraints: [
      {
        name: "project_compute_approvals_kind_state",
        type: "check",
        expression: `(kind = 'request' AND state IN ('pending','approved','dismissed','expired','superseded') AND approval_id IS NULL)
          OR (kind = 'approval' AND state IN ('pending','active','ended') AND approval_id IS NOT NULL AND funder_account_id IS NOT NULL AND funder_bay_id IS NOT NULL)`,
      },
      {
        name: "project_compute_approvals_lease",
        type: "check",
        expression: `(kind = 'approval' AND state = 'pending') = (lease_expires_at IS NOT NULL)`,
      },
      {
        name: "project_compute_approvals_layer",
        type: "check",
        expression: `NOT (kind = 'approval' AND state = 'active' AND layer_id IS NULL)`,
      },
      {
        name: "project_compute_approvals_ended",
        type: "check",
        expression: `(kind = 'approval' AND state = 'ended') = (ended_reason IS NOT NULL)`,
      },
    ],
    pg_unique_indexes: [
      "(approval_id) WHERE approval_id IS NOT NULL",
      "(project_id, provider) WHERE kind = 'request' AND state = 'pending'",
      // (columns in the other order: generated index names are truncated,
      // and must differ from the request index's)
      "(provider, project_id) WHERE kind = 'approval' AND state IN ('pending','active')",
      // a retried reserve with the same operation is the same row
      "(funder_account_id, operation_id) WHERE operation_id IS NOT NULL",
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("kind", PROJECT_COMPUTE_ROW_KINDS),
    },
    project_id: { type: "uuid", not_null: true },
    provider: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      pg_check: oneOf("provider", PROJECT_COMPUTE_PROVIDERS),
    },
    state: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("state", PROJECT_COMPUTE_ROW_STATES),
    },
    // An approval's id, made on the funder's home bay; the same id is on
    // its budget layer there.
    approval_id: { type: "uuid" },
    // the reserve call's idempotency key (with identical terms_hash)
    operation_id: { type: "uuid" },
    terms_hash: { type: "string", pg_type: "varchar(64)" },
    funder_account_id: { type: "uuid" },
    funder_bay_id: { type: "string", pg_type: "varchar(200)" },
    layer_id: { type: "uuid" },
    // Approval state version: every message from the funder's bay carries
    // one, and only a newer one applies; 'ended' is final.
    version: { type: "integer", not_null: true, pg_default: "0" },
    lease_expires_at: { type: "timestamp" },
    ended_reason: {
      type: "string",
      pg_type: "varchar(32)",
      pg_check: oneOf("ended_reason", PROJECT_COMPUTE_ENDED_REASONS),
    },
    ended_at: { type: "timestamp" },
    // The pod locator, monotone on its own version and still applied after
    // the approval ended: the project reaches every funder that may hold a
    // live pod of this project.
    live_pods: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (live_pods >= 0)",
    },
    pods_version: { type: "integer", not_null: true, pg_default: "0" },
    // Display only (the funder's bay is the authority): amount, ends_at,
    // caps, agents_allowed, the funder's name.
    display: { type: "map" },
    // Who asked (requests) or approved; for a project-bearer request the
    // account is unknown.
    actor_kind: {
      type: "string",
      pg_type: "varchar(16)",
      pg_check: oneOf("actor_kind", PROJECT_COMPUTE_ACTOR_KINDS),
    },
    actor_account_id: { type: "uuid" },
    // a request's summary: GPU type and count, $/h, the most it can cost
    request_summary: { type: "map" },
    request_expires_at: { type: "timestamp" },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

// Messages between the funder's home bay and the project's owning bay, in
// order per approval: each is delivered until the receiver's transaction has
// committed and acknowledged it. (approval_id, kind, version) identifies a
// message; resending it is harmless. The receiver is resolved at each attempt
// (the project's current owning bay, or the funder's current home).
Table({
  name: "project_funding_outbox",
  rules: {
    primary_key: "id",
    pg_indexes: ["approval_id", "next_attempt_at", "delivered_at"],
    pg_unique_indexes: ["(approval_id, kind, version)"],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    approval_id: { type: "uuid", not_null: true },
    project_id: { type: "uuid", not_null: true },
    // 'project': to the project's owning bay; 'funder': to the funder's home
    target: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: "CHECK (target IN ('project','funder'))",
    },
    funder_account_id: { type: "uuid", not_null: true },
    kind: {
      type: "string",
      pg_type: "varchar(16)",
      not_null: true,
      pg_check: oneOf("kind", PROJECT_FUNDING_MESSAGE_KINDS),
    },
    // the approval version, or for 'pods' the pods_version
    version: { type: "integer", not_null: true },
    payload: { type: "map", not_null: true },
    attempts: { type: "integer", not_null: true, pg_default: "0" },
    next_attempt_at: { type: "timestamp", not_null: true },
    claimed_until: { type: "timestamp" },
    delivered_at: { type: "timestamp" },
    last_error: { type: "string", pg_type: "varchar(500)" },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});
