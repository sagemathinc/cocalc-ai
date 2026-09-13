/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { FieldSpec, PgTableConstraint } from "./types";

// Bay-owned control-plane data; deliberately no user/project query exposure.
// Account UUIDs have no local foreign key: their home bay may be elsewhere.
const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  not_null: true,
  desc,
});
const timestamp = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const created = (desc: string): FieldSpec => ({
  ...timestamp(desc),
  not_null: true,
  pg_default: "now()",
});
const agentReference = (table: string, column: string): PgTableConstraint => ({
  name: `${table}_${column}_fkey`,
  type: "foreign-key",
  columns: [column],
  references: { table: "agent_identities", columns: ["agent_id"] },
});

Table({
  name: "agent_rpc_links",
  rules: {
    primary_key: "link_id",
    pg_constraints: [agentReference("agent_rpc_links", "source_agent_id")],
    pg_custom_indexes: [
      { name: "agent_rpc_link_source", query: "(source_agent_id)" },
    ],
  },
  fields: {
    link_id: required(
      "uuid",
      "V2 directional permission, never a delivery record.",
    ),
    source_agent_id: required("uuid", "Source identity owned by this bay."),
    target_agent_id: required(
      "uuid",
      "Remote or local target; deliberately no local foreign key.",
    ),
    target_project_id: required(
      "uuid",
      "Locator routed to its authoritative project owner.",
    ),
    approved_by: required("uuid", "Target registrant who freshly approved."),
    reason: required("string", "Human approval reason."),
    allow_guidance: {
      ...required("boolean", "Explicit steering permission."),
      pg_default: "false",
    },
    created_at: created("Approval time."),
    expires_at: { ...timestamp("Finite expiry."), not_null: true },
    revoked_at: timestamp("Revocation; never deletes prior execution."),
  },
});

Table({
  name: "agent_message_project_fences",
  rules: {
    primary_key: "project_id",
    pg_constraints: [
      {
        name: "agent_message_project_fences_project_id_fkey",
        type: "foreign-key",
        columns: ["project_id"],
        references: { table: "projects", columns: ["project_id"] },
      },
    ],
  },
  fields: {
    project_id: required("uuid", "Destination project owned by this bay."),
    host_id: required(
      "uuid",
      "Host binding; changes require explicit recovery reconciliation.",
    ),
    generation: required(
      "uuid",
      "Authoritative recovery fence, never derived from restored host data.",
    ),
    created_at: created("Initial fence issuance."),
  },
});

Table({
  name: "agent_identities",
  rules: {
    primary_key: "agent_id",
    pg_constraints: [
      {
        name: "agent_identities_project_id_fkey",
        type: "foreign-key",
        columns: ["project_id"],
        references: { table: "projects", columns: ["project_id"] },
      },
      {
        name: "agent_identities_project_id_path_thread_id_key",
        type: "unique",
        columns: ["project_id", "path", "thread_id"],
      },
    ],
  },
  fields: {
    agent_id: required("uuid", "Stable registered agent identity."),
    project_id: required("uuid", "Project owned by this bay."),
    path: required("string", "Canonical absolute chat path."),
    thread_id: required("string", "Thread bound to this identity."),
    name: required("string", "Agent display name captured at registration."),
    created_by: required("uuid", "Human registrant account."),
    created_at: created("Registration time."),
    disabled_at: timestamp("When the identity was disabled."),
    disabled_by: { type: "uuid", desc: "Account that disabled the identity." },
  },
});

Table({
  name: "agent_identity_runs",
  rules: {
    primary_key: ["agent_id", "run_id"],
    pg_constraints: [
      agentReference("agent_identity_runs", "agent_id"),
      {
        name: "agent_identity_runs_token_hash_key",
        type: "unique",
        columns: ["token_hash"],
      },
    ],
  },
  fields: {
    agent_id: required("uuid", "Registered agent."),
    run_id: required("uuid", "App-server runtime incarnation, not a turn id."),
    account_id: required("uuid", "Account executing the runtime."),
    token_hash: required(
      "string",
      "SHA-256 of the opaque credential; never plaintext.",
    ),
    issued_at: created("Original credential issuance, unchanged on renewal."),
    expires_at: { ...timestamp("Credential expiry."), not_null: true },
    ended_at: timestamp("Explicit runtime revocation time."),
  },
});

Table({
  name: "agent_message_grants",
  rules: {
    primary_key: "grant_id",
    pg_constraints: [
      agentReference("agent_message_grants", "source_agent_id"),
      agentReference("agent_message_grants", "target_agent_id"),
    ],
    pg_custom_indexes: [
      {
        name: "agent_message_grant_targets",
        query: "(source_agent_id,target_agent_id)",
      },
    ],
  },
  fields: {
    grant_id: required("uuid", "Directional send-only permission grant."),
    source_agent_id: required("uuid", "Authorized sender."),
    target_agent_id: required("uuid", "Only permitted destination."),
    allow_guidance: {
      ...required("boolean", "Whether steering an active turn is authorized."),
      pg_default: "false",
    },
    approved_by: required("uuid", "Human who approved the link."),
    reason: required("string", "Human approval reason."),
    created_at: created("Approval time."),
    expires_at: { ...timestamp("Grant expiry."), not_null: true },
    revoked_at: timestamp("Explicit grant revocation time."),
    revoked_by: { type: "uuid", desc: "Account that revoked the grant." },
  },
});

Table({
  name: "agent_message_inbox",
  rules: {
    primary_key: "message_id",
    pg_constraints: [
      agentReference("agent_message_inbox", "source_agent_id"),
      agentReference("agent_message_inbox", "target_agent_id"),
      {
        name: "agent_message_inbox_grant_id_fkey",
        type: "foreign-key",
        columns: ["grant_id"],
        references: { table: "agent_message_grants", columns: ["grant_id"] },
      },
      {
        name: "agent_message_inbox_source_agent_id_request_id_key",
        type: "unique",
        columns: ["source_agent_id", "request_id"],
      },
      {
        name: "agent_message_inbox_body_check",
        type: "check",
        expression: "octet_length(body) <= 32768",
      },
      {
        name: "agent_message_inbox_state_check",
        type: "check",
        expression:
          "state IN ('pending','dispatching','dispatched','rejected','unconfirmed')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_message_pending",
        query: "(created_at) WHERE state='pending'",
      },
      {
        name: "agent_message_target_pending",
        query: "(target_agent_id,created_at,message_id) WHERE state='pending'",
      },
      {
        name: "agent_message_target_dispatching",
        query: "(target_agent_id) WHERE state='dispatching'",
      },
      {
        name: "agent_message_source_history",
        query: "(source_agent_id,created_at DESC,message_id DESC)",
      },
      {
        name: "agent_message_receipt_due",
        query:
          "(COALESCE(receipt_check_after,created_at),message_id) WHERE state='unconfirmed' AND delivery_generation IS NOT NULL AND NOT guidance",
      },
      {
        name: "agent_message_execution_due",
        query:
          "(COALESCE(receipt_check_after,created_at),message_id) WHERE state IN ('unconfirmed','dispatched') AND delivery_generation IS NOT NULL AND NOT guidance AND COALESCE(execution_receipt->>'state','unknown') NOT IN ('completed','error','canceled','interrupted')",
      },
    ],
  },
  fields: {
    message_id: required(
      "uuid",
      "Durable delivery id, also used in the target chat.",
    ),
    request_id: required(
      "uuid",
      "Idempotency key scoped to the source identity.",
    ),
    source_agent_id: required("uuid", "Verified sender identity."),
    source_run_id: required("uuid", "Source runtime incarnation."),
    target_agent_id: required("uuid", "Destination identity."),
    grant_id: required(
      "uuid",
      "Authorization rechecked before dispatch and execution.",
    ),
    body: required(
      "string",
      "Bounded coordination message; not a permission grant.",
    ),
    guidance: required("boolean", "Whether to steer an active turn."),
    delivery_generation: {
      type: "uuid",
      desc: "Immutable target recovery generation bound before ordinary submission; null for legacy deliveries.",
    },
    admission_protocol: {
      type: "integer",
      desc: "One-use owning-bay admission protocol; null for legacy deliveries which cannot safely opt in retroactively.",
    },
    admission_operation_id: {
      type: "uuid",
      desc: "Immutable assistant operation reserved by the one queue attempt.",
    },
    admission_started_at: timestamp(
      "Queue-attempt permission consumed; never cleared to authorize a retry.",
    ),
    receipt_check_after: timestamp(
      "Durable pacing for lookup-only reconciliation, not permission to resend.",
    ),
    execution_receipt: {
      type: "map",
      desc: "Minimal versioned execution observation; no receiver content or tool output.",
    },
    state: required("string", "Delivery state, not model completion status."),
    created_at: created("Durable acceptance time."),
    updated_at: created("Latest delivery state transition."),
  },
});
