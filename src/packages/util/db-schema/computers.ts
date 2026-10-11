/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers: machines an account connects so its agents can run commands,
// jobs and file transfers there. Plan: src/.agents/computers-plan-2026-10-11.md
// ("Data model"). Control-plane data only: no user/project query exposure.
// Account and project UUIDs have no local foreign keys, since their owning
// bays may be elsewhere.

import { Table } from "./types";
import type { FieldSpec } from "./types";

const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  not_null: true,
  desc,
});
const optional = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
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
const json = (desc: string, not_null = true): FieldSpec => ({
  type: "map",
  pg_type: "JSONB",
  not_null,
  desc,
});
const counter = (desc: string, start = "0"): FieldSpec => ({
  type: "integer",
  pg_type: "BIGINT",
  not_null: true,
  pg_default: start,
  desc,
});

// Account home bay: the computer, its policy ceiling and epochs.
Table({
  name: "account_computers",
  rules: {
    primary_key: "computer_id",
    pg_constraints: [
      {
        name: "account_computers_mode_check",
        type: "check",
        expression: "mode IN ('direct','isolated')",
      },
      {
        name: "account_computers_origin_check",
        type: "check",
        expression: "origin = 'user' OR origin LIKE 'provider:%'",
      },
    ],
    pg_custom_indexes: [
      {
        name: "account_computers_account_name",
        unique: true,
        query: "(account_id,name) WHERE tombstoned_at IS NULL",
      },
      {
        name: "account_computers_signing_key",
        unique: true,
        query: "(signing_key)",
      },
      {
        name: "account_computers_network",
        query: "(account_id,agent_network_id) WHERE revoked_at IS NULL",
      },
    ],
  },
  fields: {
    computer_id: required("uuid", "Stable computer id."),
    account_id: required("uuid", "Owning account (account-home authority)."),
    name: required("string", "Alias, unique per account (@name)."),
    hostname: required("string", "Machine hostname at pairing."),
    os: required("string", "Machine OS at pairing."),
    arch: required("string", "Machine architecture at pairing."),
    machine_user: required("string", "OS user the daemon runs as."),
    mode: required("string", "direct (full trust) or isolated."),
    agent_network_id: required(
      "uuid",
      "The agent network whose registered members this computer serves.",
    ),
    policy_ceiling: json(
      "Approved policy ceiling P0, as resolved on the machine.",
    ),
    ceiling_hash: required("string", "Hash of the canonical policy ceiling."),
    effective_policy: json("Current effective policy, at most the ceiling."),
    policy_epoch: counter("Monotonic effective-policy epoch."),
    epoch: counter(
      "Monotonic computer epoch; bumped by revocation and by narrowing the agent network.",
      "1",
    ),
    home_bay_id: required("string", "Bay that issued the certificate."),
    home_epoch: counter("Account home-bay ownership epoch at pairing."),
    signing_key: required(
      "string",
      "Fingerprint of the machine's Ed25519 key.",
    ),
    signing_public_key: required("string", "base64url DER of the signing key."),
    agreement_key: required(
      "string",
      "Fingerprint of the machine's X25519 key.",
    ),
    transcript_hash: required(
      "string",
      "Hash of the approved pairing transcript.",
    ),
    certificate: json("Signed computer certificate."),
    request_id: required("string", "Pairing request that created it."),
    origin: {
      ...required("string", "user, or provider:<connection id>."),
      pg_default: "'user'::character varying",
    },
    deadline: timestamp("Current session deadline; null without a time limit."),
    max_deadline: timestamp("Latest possible deadline (from max_duration)."),
    notes: {
      type: "string",
      pg_type: "TEXT",
      not_null: true,
      pg_default: "''::text",
      desc: "Short markdown notes (at most 4 KB); agents treat them as data.",
    },
    notes_revision: counter("Monotonic notes revision."),
    notes_locked: {
      type: "boolean",
      not_null: true,
      pg_default: "false",
      desc: "Only the owner may edit the notes.",
    },
    notes_history: json("The last 20 notes versions with authors."),
    connected_at: timestamp("Last time the daemon connected."),
    last_seen: timestamp("Last time the daemon was heard from."),
    created_at: created("Pairing approval time."),
    updated_at: created("Last change."),
    revoked_at: timestamp("Disconnected or revoked; no new tickets."),
    tombstoned_at: timestamp(
      "Deleted: kept until its certificate can no longer be valid.",
    ),
  },
});

// Account home bay: a request to connect a computer, and its pairing.
Table({
  name: "account_computer_requests",
  rules: {
    primary_key: "request_id",
    pg_constraints: [
      {
        name: "account_computer_requests_state_check",
        type: "check",
        expression:
          "state IN ('pending','paired','approved','declined','expired','invalidated')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "account_computer_requests_account",
        query: "(account_id,created_at DESC)",
      },
      {
        name: "account_computer_requests_expiry",
        query: "(expires_at) WHERE state IN ('pending','paired')",
      },
      {
        name: "account_computer_requests_network",
        query: "(account_id,agent_network_id) WHERE state IN ('pending','paired')",
      },
    ],
  },
  fields: {
    request_id: required("string", "Non-secret request id (R-XXXXXXXXXX)."),
    account_id: required("uuid", "Account the computer will belong to."),
    requested_by_agent_id: optional("uuid", "Agent that asked, if any."),
    requested_by_run_id: optional("uuid", "Agent run that asked, if any."),
    source_project_id: optional("uuid", "Project of the requesting agent."),
    thread_id: optional("string", "Chat thread of the request card."),
    name: required("string", "Requested alias."),
    requested_policy: json("Requested policy, before local resolution."),
    agent_network_id: required(
      "uuid",
      "Agent network the computer would serve (from the requested policy).",
    ),
    why: {
      type: "string",
      pg_type: "TEXT",
      not_null: true,
      pg_default: "''::text",
      desc: "Why the agent asks.",
    },
    state: required(
      "string",
      "pending, paired, approved, declined, expired, invalidated.",
    ),
    server_nonce: required("string", "Nonce for the pairing transcript."),
    transcript: json("Signed pairing transcript from the machine.", false),
    transcript_hash: optional("string", "Hash of the transcript."),
    pairing_phrase: optional("string", "Phrase derived from the transcript."),
    resolved_policy: json("Policy as resolved on the machine.", false),
    claimants: counter(
      "Pairing attempts; a second one invalidates the request.",
    ),
    computer_id: optional("uuid", "Computer created by approval."),
    approved_by: optional("uuid", "Account that approved."),
    approved_network_generation: optional(
      "string",
      "Agent network generation (membership) the owner reviewed at approval.",
    ),
    approved_at: timestamp("Approval time."),
    expires_at: { ...timestamp("Request expiry."), not_null: true },
    created_at: created("Request time."),
    updated_at: created("Last change."),
  },
});

// Account home bay: one row per operation, the audit (90 days).
Table({
  name: "account_computer_operations",
  rules: {
    primary_key: ["computer_id", "operation_id"],
    pg_constraints: [
      {
        name: "account_computer_operations_state_check",
        type: "check",
        expression:
          "state IN ('issued','admitted','running','done','failed','unknown','refused')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "account_computer_operations_account",
        query: "(account_id,computer_id,issued_at DESC)",
      },
      {
        name: "account_computer_operations_expiry",
        query: "(issued_at)",
      },
    ],
  },
  fields: {
    computer_id: required("uuid", "Computer."),
    operation_id: required("uuid", "Client-chosen id, reused across retries."),
    account_id: required("uuid", "Owning account."),
    agent_id: required("uuid", "Agent that asked."),
    run_id: required("uuid", "Agent run that asked."),
    source_project_id: required("uuid", "Project of the agent."),
    thread_id: optional("string", "Chat thread, if known."),
    operation: required("string", "exec, run, put, get, ..."),
    request_hash: required(
      "string",
      "Canonical request hash; a retry must match.",
    ),
    command: {
      type: "string",
      pg_type: "TEXT",
      desc: "Command line or paths (owner may switch to hash plus prefix).",
    },
    description: optional("string", "Short description (required for jobs)."),
    ticket_id: required("uuid", "Last ticket issued for this operation."),
    pop_key: required(
      "string",
      "Proof-of-possession key of the requester; a retry must present the same.",
    ),
    state: required(
      "string",
      "issued, admitted, running, done, failed, unknown, refused.",
    ),
    exit_code: optional("integer", "Exit code, when known."),
    image_digest: optional("string", "Pinned image digest (isolated mode)."),
    connectors: json("Connector names passed to the job.", false),
    bytes_in: counter("CoCalc-counted bytes into the computer."),
    bytes_out: counter("CoCalc-counted bytes from the computer."),
    issued_at: created("Ticket issue time."),
    started_at: timestamp("Start on the machine."),
    finished_at: timestamp("End on the machine."),
  },
});

// Account home bay: mirror of each job, for `jobs`, Settings and sensors.
Table({
  name: "account_computer_jobs",
  rules: {
    primary_key: ["computer_id", "job_id"],
    pg_constraints: [
      {
        name: "account_computer_jobs_state_check",
        type: "check",
        expression:
          "state IN ('queued','running','done','failed','killed','unknown')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "account_computer_jobs_active",
        query: "(computer_id) WHERE state IN ('queued','running')",
      },
    ],
  },
  fields: {
    computer_id: required("uuid", "Computer."),
    job_id: required("uuid", "The operation id of the run."),
    account_id: required("uuid", "Owning account."),
    agent_id: required("uuid", "Agent that started it."),
    source_project_id: required("uuid", "Project of the agent."),
    thread_id: optional("string", "Chat thread, if known."),
    name: optional("string", "Short name label."),
    description: required("string", "Required short description."),
    command: { type: "string", pg_type: "TEXT", desc: "Command line." },
    image_digest: optional("string", "Image digest (isolated)."),
    exclusive: {
      type: "boolean",
      not_null: true,
      pg_default: "false",
      desc: "Runs only while no other CoCalc job runs there.",
    },
    nice: {
      type: "boolean",
      not_null: true,
      pg_default: "true",
      desc: "Runs under nice/ionice.",
    },
    state: required(
      "string",
      "queued, running, done, failed, killed, unknown.",
    ),
    exit_code: optional("integer", "Exit code."),
    resources: json("Latest CPU/memory/GPU use.", false),
    created_at: created("Admission time."),
    started_at: timestamp("Start time."),
    finished_at: timestamp("End time."),
    updated_at: created("Last report."),
  },
});

// Account home: every ticket issued, for hard per-run and per-computer rate
// limits (a retry of one operation still counts). Pruned after an hour.
Table({
  name: "account_computer_ticket_log",
  rules: {
    primary_key: "ticket_id",
    pg_custom_indexes: [
      {
        name: "account_computer_ticket_log_computer",
        query: "(computer_id,issued_at)",
      },
      { name: "account_computer_ticket_log_run", query: "(run_id,issued_at)" },
    ],
  },
  fields: {
    ticket_id: required("uuid", "Ticket."),
    account_id: required("uuid", "Owning account."),
    computer_id: required("uuid", "Computer."),
    run_id: required("uuid", "Agent run that asked."),
    issued_at: created("Issue time."),
  },
});

// Seed: the public keys bays sign computer certificates, attestations and
// tickets with. Daemons get this directory at pairing and in signed updates.
Table({
  name: "cluster_computer_signing_keys",
  rules: { primary_key: "kid" },
  fields: {
    kid: required("string", "Key fingerprint (sha256:...)."),
    bay_id: required("string", "Bay that holds the private key."),
    public_key: required("string", "base64url DER of the Ed25519 public key."),
    endorsed_by: optional(
      "string",
      "kid of the key that endorsed this one (rotation chain).",
    ),
    endorsement: optional(
      "string",
      "The endorsing key's signed endorsement (JSON envelope).",
    ),
    created_at: created("Creation time."),
    not_after: {
      ...timestamp("Last time this key may be trusted."),
      not_null: true,
    },
    revoked_at: timestamp("Revocation time."),
  },
});

// Each bay: its own private signing keys, encrypted with secret storage.
Table({
  name: "bay_computer_signing_keys",
  rules: { primary_key: "kid" },
  fields: {
    kid: required("string", "Key fingerprint (sha256:...)."),
    encrypted_private_key: {
      type: "string",
      pg_type: "TEXT",
      not_null: true,
      desc: "PKCS#8 PEM, encrypted by secret storage.",
    },
    public_key: required("string", "base64url DER of the Ed25519 public key."),
    not_after: {
      ...timestamp("Last time this key may be trusted."),
      not_null: true,
    },
    endorsed_by: optional(
      "string",
      "kid of the previous key, which endorsed this one.",
    ),
    endorsement: optional(
      "string",
      "The previous key's signed endorsement (JSON envelope).",
    ),
    created_at: created("Creation time."),
    retired_at: timestamp("No longer used to sign."),
  },
});
