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
  name: "agent_rpc_admission_state",
  rules: {
    primary_key: "token_id",
    pg_constraints: [
      {
        name: "agent_rpc_admission_state_kind_check",
        type: "check",
        expression: "kind IN ('permit','preparation')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_rpc_admission_state_expiry",
        query: "(expires_at)",
      },
      {
        name: "agent_rpc_admission_state_project",
        query: "(project_id,kind,expires_at)",
      },
    ],
  },
  fields: {
    token_id: required("uuid", "Opaque short-lived permit or reservation ID."),
    kind: required("string", "Permit or single-use attachment preparation."),
    binding_hash: required(
      "string",
      "SHA-256 of the canonical request binding; no message body is retained.",
    ),
    host_id: required("uuid", "Exact destination host binding."),
    project_id: required("uuid", "Exact destination project binding."),
    account_id: required("uuid", "Execution principal binding."),
    created_at: created("Capability creation time."),
    expires_at: { ...timestamp("Short capability expiry."), not_null: true },
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
    ],
    pg_custom_indexes: [
      {
        name: "agent_identities_active_thread",
        unique: true,
        query: "(project_id,path,thread_id) WHERE disabled_at IS NULL",
      },
    ],
  },
  fields: {
    agent_id: required("uuid", "Stable registered agent identity."),
    project_id: required("uuid", "Project owned by this bay."),
    path: required("string", "Canonical absolute chat path."),
    thread_id: required("string", "Thread bound to this identity."),
    conversation_history: {
      type: "array",
      pg_type: "JSONB",
      desc: "Previous conversations of this stable identity, in chronological order.",
    },
    name: required("string", "Agent display name captured at registration."),
    created_by: required("uuid", "Human registrant account."),
    created_at: created("Registration time."),
    disabled_at: timestamp("When the identity was disabled."),
    disabled_by: { type: "uuid", desc: "Account that disabled the identity." },
    replaced_by: {
      type: "uuid",
      desc: "Replacement identity created by explicit owner recovery.",
    },
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
