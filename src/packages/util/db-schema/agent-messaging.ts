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
  name: "agent_rpc_report_executions",
  rules: {
    primary_key: "attempt_id",
    pg_custom_indexes: [
      {
        name: "agent_rpc_report_executions_expiry",
        query: "(expires_at)",
      },
    ],
  },
  fields: {
    attempt_id: required(
      "uuid",
      "The reported message: a delivery report starts at most one turn.",
    ),
    report_id: required("uuid", "The report whose turn ran."),
    account_id: required("uuid", "Execution principal binding."),
    project_id: required("uuid", "The sender's project, where the turn ran."),
    host_id: required("uuid", "The host that ran it."),
    path: required("string", "The sender's chat."),
    thread_id: required("string", "The sender's thread."),
    created_at: created("When the report's turn was authorized."),
    expires_at: {
      ...timestamp("Kept until after the report's capability expired."),
      not_null: true,
    },
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
    runtime: {
      type: "map",
      pg_type: "JSONB",
      desc: "Runtime kind ({kind: codex | claude-code | acp, name?}), recorded at registration from the thread's configuration and confirmed by the project host when it admits a turn.",
    },
  },
});

// How an account pays for its agents' turns, in the account's home bay so all
// of its devices and every turn (human, agent message, CLI) see the same
// choice. Kept out of project-owned identity rows, which every collaborator
// can read. Values are credential references, never secrets.
Table({
  name: "agent_payment_selections",
  rules: {
    primary_key: ["account_id", "target_key", "provider"],
    pg_custom_indexes: [
      {
        name: "agent_payment_selections_provider",
        query: "(account_id,provider,updated_at)",
      },
    ],
  },
  fields: {
    account_id: required(
      "uuid",
      "Account that pays; its home bay owns the row.",
    ),
    target_key: required(
      "string",
      "'thread:<project_id>:<thread_id>' for one agent, or 'default:<provider>'.",
    ),
    provider: required("string", "codex or claude-code."),
    project_id: { type: "uuid", desc: "Agent project; null for defaults." },
    path: { type: "string", desc: "Agent chat path; null for defaults." },
    thread_id: { type: "string", desc: "Agent thread; null for defaults." },
    selection: {
      ...required("map", "Versioned credential-reference selection."),
      pg_type: "JSONB",
    },
    title: { type: "string", desc: "Agent name at the last change." },
    updated_at: created("Last change by the account."),
    last_used_at: timestamp("Last turn admitted with this selection."),
  },
});

// Accounts that named an agent (in their home bays' name books). Kept with the
// identity so its changes reach exactly those name books.
Table({
  name: "agent_identity_watchers",
  rules: {
    primary_key: ["agent_id", "account_id"],
    pg_custom_indexes: [
      { name: "agent_identity_watchers_project", query: "(project_id)" },
    ],
  },
  fields: {
    agent_id: required("uuid", "Registered agent."),
    account_id: required("uuid", "Account that named the agent."),
    project_id: required("uuid", "Agent project, for hard deletion."),
    created_at: created("When the account named the agent."),
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
  name: "agent_connector_grants",
  rules: {
    primary_key: "grant_id",
    pg_custom_indexes: [
      {
        name: "agent_connector_grants_owner_agent_connector_key",
        unique: true,
        query: "(account_id,agent_id,source_project_id,connector)",
      },
    ],
  },
  fields: {
    grant_id: required("uuid", "Stable grant ID."),
    account_id: required("uuid", "Human who owns this grant."),
    agent_id: required("uuid", "Registered native agent."),
    source_project_id: required("uuid", "Project containing the agent."),
    connector: required(
      "string",
      "CLI connector kind, e.g. github or cloudflare.",
    ),
    connection_id: {
      type: "uuid",
      desc: "Account connection (external credential) this agent may use.",
    },
    scope: {
      type: "map",
      pg_type: "JSONB",
      not_null: true,
      desc: "Connector-specific limits; no credential is stored.",
    },
    revision: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      desc: "Monotonic grant revision.",
    },
    enabled: {
      type: "boolean",
      not_null: true,
      pg_default: "false",
      desc: "Whether a future verified turn may receive a token.",
    },
    created_at: created("Grant creation time."),
    updated_at: created("Last grant update."),
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

// Agent memory, in the account's home bay: one row per account (on/off,
// namespaces and which projects see them) and one row per note. Descriptions
// and bodies are encrypted with the site's secret-storage key.
Table({
  name: "agent_memory_accounts",
  rules: {
    primary_key: "account_id",
  },
  fields: {
    account_id: required("uuid", "Account whose agent memory this is."),
    enabled: {
      ...required("boolean", "Whether agents may use the memory."),
      pg_default: "false",
    },
    namespaces: {
      ...required("map", "Namespaces: [{name, description?}]."),
      pg_type: "JSONB",
      pg_default: "'[]'::jsonb",
    },
    projects: {
      ...required("map", "project_id -> attached namespace names."),
      pg_type: "JSONB",
      pg_default: "'{}'::jsonb",
    },
    migrated_at: timestamp(
      "When notes of the first version's single record were first moved here.",
    ),
    legacy_version: {
      type: "string",
      desc: "Hash of the first version's record as last absorbed (rolling upgrades).",
    },
    legacy_notes: {
      type: "map",
      pg_type: "JSONB",
      desc: "Fingerprint of each note in that record, so only notes an old hub changed are absorbed again.",
    },
    legacy_absorbed_at: timestamp(
      "When the first version's record was last absorbed.",
    ),
    updated_at: created("Last settings change."),
  },
});

Table({
  name: "agent_memory_notes",
  rules: {
    primary_key: ["account_id", "namespace", "name"],
    pg_custom_indexes: [
      {
        name: "agent_memory_notes_recent",
        query: "(account_id,namespace,updated_at)",
      },
      {
        name: "agent_memory_notes_expiry",
        query: "(expires_at) WHERE expires_at IS NOT NULL",
      },
    ],
  },
  fields: {
    account_id: required("uuid", "Account whose note this is."),
    namespace: required(
      "string",
      "'global' or one of the account's namespaces.",
    ),
    name: required("string", "Kebab-case name, unique in its namespace."),
    description: required("string", "Encrypted one-line description."),
    body: required("string", "Encrypted note text."),
    bytes: {
      ...required("integer", "Plain-text bytes of description and body."),
      pg_default: "0",
    },
    project_id: {
      type: "uuid",
      desc: "Project the note was last written from; ranks it first there.",
    },
    created_at: created("When the note was first saved."),
    updated_at: created("Last write."),
    last_read_at: timestamp("Last time an agent read the note."),
    read_count: {
      ...required("integer", "Times an agent read the note."),
      pg_default: "0",
    },
    written_by_agent_id: {
      type: "uuid",
      desc: "Registered agent that last wrote the note; null if unknown (notes from before authorship was kept).",
    },
    written_by_name: {
      type: "string",
      desc: "That agent's name when it wrote the note, shown if the account no longer names it.",
    },
    ttl_seconds: {
      type: "integer",
      desc: "Delete the note after this long without a read or write; null for never.",
    },
    expires_at: timestamp(
      "When the note expires unless read or written again (last use + ttl_seconds).",
    ),
    attributed_at: timestamp(
      "updated_at of the write that set written_by_* and ttl_seconds. A later write by a hub that does not keep them (rolling upgrade, first-version record) changes updated_at only, so they no longer apply.",
    ),
  },
});

// The agents whose own memory scope an account keeps, and when each last had
// a turn, so the scope of an agent nobody uses any more can be deleted.
Table({
  name: "agent_memory_agents",
  rules: {
    primary_key: ["account_id", "agent_id"],
    pg_custom_indexes: [
      {
        name: "agent_memory_agents_last_turn",
        query: "(last_turn_at)",
      },
    ],
  },
  fields: {
    account_id: required("uuid", "Account whose memory keeps the scope."),
    agent_id: required("uuid", "Registered agent the scope belongs to."),
    name: required("string", "The agent's name at its last turn."),
    last_turn_at: created("Last turn this agent ran for the account."),
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
