/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";
import type { FieldSpec } from "./types";

const field = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  desc,
  not_null: true,
});
const time = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const created = {
  ...time("Creation time."),
  not_null: true,
  pg_default: "now()",
};
const generation = {
  ...field("integer", "Account-wide messaging revocation generation."),
  pg_default: "0",
};

// Account-home authoritative records. Remote project IDs deliberately have no
// local FK because their owning bay is authoritative for project state.
Table({
  name: "agent_personal_controls",
  rules: { primary_key: "account_id" },
  fields: {
    account_id: field("uuid", "Account authority."),
    paused: {
      ...field("boolean", "Restrictive account-wide messaging pause."),
      pg_default: "false",
    },
    generation,
  },
});

Table({
  name: "agent_personal_names",
  rules: {
    primary_key: ["account_id", "name"],
    pg_custom_indexes: [
      {
        name: "agent_personal_current_endpoint",
        unique: true,
        query: "(account_id,project_id,agent_id) WHERE retired_at IS NULL",
      },
    ],
  },
  fields: {
    account_id: field("uuid", "Naming account."),
    name: field("string", "Normalized name; retained after rename."),
    project_id: field("uuid", "Owning project locator."),
    agent_id: field("uuid", "Immutable identity."),
    metadata: field(
      "map",
      "Safe account-authored metadata and identity path/thread snapshot; no message body.",
    ),
    retired_at: time("Tombstone; never retarget a retired name."),
    created_at: created,
    updated_at: created,
  },
});

Table({
  name: "agent_sessions",
  rules: {
    primary_key: "agent_session_id",
    pg_constraints: [
      {
        name: "agent_sessions_state_check",
        type: "check",
        expression: "state IN ('active','paused','closed')",
      },
      {
        name: "agent_sessions_delivery_check",
        type: "check",
        expression: "delivery_mode IN ('queued','live')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_sessions_account_updated",
        query: "(account_id,updated_at DESC,agent_session_id)",
      },
    ],
  },
  fields: {
    agent_session_id: field("uuid", "Stable Agent Session identifier."),
    account_id: field("uuid", "Account-home authority and human principal."),
    title: { type: "string", desc: "Optional human title, at most 120 chars." },
    state: {
      ...field("string", "active, paused, or closed."),
      pg_default: "'active'::character varying",
    },
    delivery_mode: {
      ...field("string", "queued or live."),
      pg_default: "'queued'::character varying",
    },
    generation: field("uuid", "Changes on every authority mutation."),
    created_by: field("uuid", "Human account that created the session."),
    created_at: created,
    updated_at: created,
    closed_at: time("Terminal close time."),
  },
});

Table({
  name: "agent_session_members",
  rules: {
    primary_key: ["agent_session_id", "member_kind", "member_id"],
    pg_constraints: [
      {
        name: "agent_session_member_kind_check",
        type: "check",
        expression: "member_kind IN ('registered','external')",
      },
      {
        name: "agent_session_member_identity_check",
        type: "check",
        expression:
          "(member_kind='registered' AND registered_agent_id IS NOT NULL AND project_id IS NOT NULL AND external_agent_id IS NULL AND installation_id IS NULL) OR (member_kind='external' AND external_agent_id IS NOT NULL AND installation_id IS NOT NULL AND registered_agent_id IS NULL AND project_id IS NULL)",
      },
      {
        name: "agent_session_members_session_fkey",
        type: "foreign-key",
        columns: ["agent_session_id"],
        references: { table: "agent_sessions", columns: ["agent_session_id"] },
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_session_registered_member",
        query:
          "(registered_agent_id,agent_session_id) WHERE removed_at IS NULL AND member_kind='registered'",
      },
      {
        name: "agent_session_external_member",
        query:
          "(external_agent_id,agent_session_id) WHERE removed_at IS NULL AND member_kind='external'",
      },
    ],
  },
  fields: {
    agent_session_id: field("uuid", "Containing Agent Session."),
    member_kind: field("string", "registered or external."),
    member_id: field("uuid", "Stable member identity within the account."),
    registered_agent_id: { type: "uuid", desc: "Registered agent identity." },
    project_id: { type: "uuid", desc: "Registered agent project locator." },
    external_agent_id: { type: "uuid", desc: "External agent identity." },
    installation_id: { type: "uuid", desc: "Approved external installation." },
    added_by: field("uuid", "Human account that approved membership."),
    added_at: created,
    removed_at: time("Membership revocation time."),
  },
});

Table({
  name: "agent_session_mutations",
  rules: {
    primary_key: ["account_id", "request_id"],
    pg_custom_indexes: [
      {
        name: "agent_session_mutations_retention",
        query: "(account_id,created_at DESC)",
      },
    ],
  },
  fields: {
    account_id: field("uuid", "Account authority."),
    request_id: field("uuid", "Human mutation idempotency key."),
    binding_hash: field("string", "Canonical mutation binding hash."),
    agent_session_id: field("uuid", "Resulting or mutated session."),
    created_at: created,
  },
});

Table({
  name: "agent_session_activity",
  rules: {
    primary_key: "attempt_id",
    pg_constraints: [
      {
        name: "agent_session_activity_outcome_check",
        type: "check",
        expression:
          "outcome IS NULL OR outcome IN ('accepted','rejected','unknown')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_session_activity_recent",
        query: "(account_id,agent_session_id,observed_at DESC)",
      },
    ],
  },
  fields: {
    attempt_id: field("uuid", "Exact send attempt correlation ID."),
    account_id: field("uuid", "Session account principal."),
    agent_session_id: field("uuid", "Authorizing session."),
    session_generation: field("uuid", "Generation checked for this attempt."),
    source_member_id: field("uuid", "Authenticated source member."),
    target_member_id: field("uuid", "Exact target member."),
    configured_delivery: field("string", "queued or live."),
    effective_delivery: { type: "string", desc: "Observed delivery path." },
    outcome: { type: "string", desc: "accepted, rejected, or unknown." },
    observed_at: created,
  },
});

Table({
  name: "agent_session_proposals",
  rules: {
    primary_key: "proposal_id",
    pg_constraints: [
      {
        name: "agent_session_proposals_state_check",
        type: "check",
        expression: "state IN ('pending','approved','rejected','expired')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_session_proposals_pending",
        query: "(account_id,created_at DESC) WHERE state='pending'",
      },
    ],
  },
  fields: {
    proposal_id: field("uuid", "Agent-supplied idempotency key."),
    account_id: field("uuid", "Human account that may resolve this proposal."),
    source: {
      ...field("map", "Authenticated registered or external source."),
      pg_type: "JSONB",
    },
    title: { type: "string", desc: "Optional proposed session title." },
    delivery_mode: field("string", "queued or live."),
    members: {
      ...field("map", "Bounded explicit proposed member locators."),
      pg_type: "JSONB",
    },
    reason: { type: "string", desc: "Optional agent-provided reason." },
    state: {
      ...field("string", "pending, approved, rejected, or expired."),
      pg_default: "'pending'::character varying",
    },
    binding_hash: field("string", "Canonical proposal idempotency binding."),
    created_at: created,
    expires_at: {
      ...time("Automatic proposal expiry."),
      not_null: true,
    },
    resolved_at: time("Human resolution time."),
    agent_session_id: { type: "uuid", desc: "Approved resulting session." },
  },
});

Table({
  name: "agent_session_broadcasts",
  rules: {
    primary_key: ["account_id", "broadcast_id"],
    pg_custom_indexes: [
      {
        name: "agent_session_broadcasts_retention",
        query: "(account_id,created_at DESC)",
      },
    ],
  },
  fields: {
    account_id: field("uuid", "Session authority account."),
    broadcast_id: field("uuid", "Parent broadcast idempotency key."),
    agent_session_id: field("uuid", "Exact authorizing session."),
    source: {
      ...field("map", "Authenticated source principal."),
      pg_type: "JSONB",
    },
    binding_hash: field(
      "string",
      "Canonical source/session/targets/body hash.",
    ),
    state: field("string", "pending or complete."),
    outcome: { type: "map", pg_type: "JSONB", desc: "Bounded child outcomes." },
    created_at: created,
    updated_at: created,
  },
});
