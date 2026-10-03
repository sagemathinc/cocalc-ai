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
    collaborator_access: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Creator's stated preference for other collaborators: 'view' asks them to only view; null means they may message. A convention, not enforced.",
    },
    appearance: {
      type: "map",
      pg_type: "JSONB",
      desc: "Copy of the thread's theme (title, colors, icon, image) so agent lists show it without loading the chat. The .chat thread metadata is the source.",
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
    thread_id: {
      type: "string",
      desc: "Conversation at run issuance; absent on legacy runs.",
    },
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
  name: "agent_cocalc_connector_configs",
  rules: {
    primary_key: "config_id",
    pg_custom_indexes: [
      {
        name: "agent_cocalc_connector_configs_owner_agent_source_key",
        unique: true,
        query: "(account_id,agent_id,source_project_id)",
      },
    ],
  },
  fields: {
    config_id: required("uuid", "Stable configuration ID."),
    account_id: required("uuid", "Human who owns this configuration."),
    agent_id: required("uuid", "Registered native agent."),
    source_project_id: required("uuid", "Project containing the agent."),
    scope: {
      type: "map",
      pg_type: "JSONB",
      not_null: true,
      desc: "Canonical versioned API-key scope; no credential is stored.",
    },
    revision: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      desc: "Monotonic configuration revision.",
    },
    enabled: {
      type: "boolean",
      not_null: true,
      pg_default: "false",
      desc: "Whether a future verified turn may receive this scope.",
    },
    created_at: created("Configuration creation time."),
    updated_at: created("Last configuration update."),
  },
});

Table({
  name: "agent_cocalc_connector_turns",
  rules: {
    primary_key: "turn_id",
    pg_custom_indexes: [
      {
        name: "agent_cocalc_connector_turns_idempotency_key",
        unique: true,
        query: "(account_id,agent_id,source_project_id,run_id,idempotency_key)",
      },
      {
        name: "agent_cocalc_connector_turns_owner_expiry_idx",
        query: "(account_id,expires_at)",
      },
    ],
  },
  fields: {
    turn_id: required("uuid", "Server-allocated turn credential binding ID."),
    account_id: required("uuid", "Human who owns the ordinary API key."),
    agent_id: required("uuid", "Registered native agent."),
    source_project_id: required("uuid", "Agent source project."),
    source_host_id: required("uuid", "Authenticated source host at issuance."),
    run_id: required(
      "uuid",
      "Live native-agent run attested by its owner bay.",
    ),
    chat_path: {
      type: "string",
      desc: "Source chat path for newly issued authenticated turns.",
    },
    message_date: {
      type: "string",
      desc: "Source message date for newly issued authenticated turns.",
    },
    message_id: {
      type: "string",
      desc: "Source message ID for newly issued authenticated turns.",
    },
    thread_id: {
      type: "string",
      desc: "Source thread ID for newly issued authenticated turns.",
    },
    idempotency_key: required("uuid", "Trusted runtime's per-turn retry key."),
    config_id: required("uuid", "Saved human consent configuration."),
    config_revision: required("integer", "Consent revision at issuance."),
    key_id: required("string", "Ordinary account API-key lookup ID."),
    secret_ciphertext: {
      ...required("string", "Encrypted key for idempotent trusted retries."),
      pg_type: "TEXT",
    },
    expires_at: { ...timestamp("Short managed key expiry."), not_null: true },
    ended_at: timestamp("Explicit lifecycle revocation time."),
    created_at: created("Turn credential issuance time."),
    renewed_at: created("Last successful renewal time."),
  },
});

// Per-account agent memory usage counters in the account's home bay. One row
// per account; updated atomically by every hub process in the bay.
Table({
  name: "agent_memory_usage",
  rules: {
    primary_key: "account_id",
  },
  fields: {
    account_id: required("uuid", "Account whose agent memory is used."),
    minute_start: {
      ...created("Start of the current one-minute window."),
    },
    minute_reads: {
      ...required("integer", "Agent reads this minute."),
      pg_default: "0",
    },
    minute_writes: {
      ...required("integer", "Agent writes this minute."),
      pg_default: "0",
    },
    hour_start: { ...created("Start of the current one-hour window.") },
    hour_bytes: {
      ...required("number", "Bytes written by agents this hour."),
      pg_type: "BIGINT",
      pg_default: "0",
    },
  },
});
