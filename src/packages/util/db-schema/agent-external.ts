/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";
import type { FieldSpec } from "./types";

const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
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

// Only human-approved installations live here. Anonymous enrollment belongs to
// the CLI-auth challenge flow, not the account's persistent agent registry.
Table({
  name: "agent_external_identities",
  rules: { primary_key: "agent_id" },
  fields: {
    agent_id: required(
      "uuid",
      "Stable external identity; never a native project-thread agent.",
    ),
    account_id: required("uuid", "Approving account and home-bay authority."),
    label: required("string", "Human-visible label, not a native @ address."),
    created_at: created,
    disabled_at: time("Permanent disable; retains attribution history."),
  },
});
Table({
  name: "agent_external_installations",
  rules: {
    primary_key: "installation_id",
    pg_custom_indexes: [
      {
        name: "agent_external_installation_account",
        query: "(account_id,created_at DESC)",
      },
    ],
  },
  fields: {
    installation_id: required(
      "uuid",
      "Bound enrollment challenge ID and independent revocation handle.",
    ),
    account_id: required(
      "uuid",
      "Approver and execution principal; account-home authoritative.",
    ),
    agent_id: required("uuid", "Bound external identity."),
    label: required(
      "string",
      "Installation label explicitly reviewed by the human.",
    ),
    secret_hash: required(
      "string",
      "SHA-256 of the client-held 256-bit secret; never a human session.",
    ),
    state: required(
      "string",
      "active or permanently revoked; no automatic renewal.",
    ),
    generation: required(
      "integer",
      "Personal messaging revocation generation at approval.",
    ),
    approval: required(
      "map",
      "Canonical approval parameters for duplicate approval conflict detection.",
    ),
    agent_session_id: {
      ...required(
        "uuid",
        "Exact two-way Agent Session approved for this installation.",
      ),
      // Legacy send-only installations deliberately receive an unresolvable
      // session id, so the hard cutover fails closed without blocking startup.
      pg_null_backfill: "gen_random_uuid()",
    },
    created_at: created,
    expires_at: {
      ...time("Finite credential expiry, at most 30 days after approval."),
      not_null: true,
    },
  },
});

Table({
  name: "agent_external_inbox",
  rules: {
    primary_key: "message_id",
    pg_constraints: [
      {
        name: "agent_external_inbox_attempt_key",
        type: "unique",
        columns: ["account_id", "attempt_id"],
      },
      {
        name: "agent_external_inbox_body_check",
        type: "check",
        expression: "octet_length(body) BETWEEN 1 AND 32768",
      },
      {
        name: "agent_external_inbox_state_check",
        type: "check",
        expression: "state IN ('pending','acknowledged')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_external_inbox_pending",
        query:
          "(account_id,installation_id,created_at,message_id) WHERE state='pending'",
      },
      {
        name: "agent_external_inbox_expiry",
        query: "(expires_at)",
      },
    ],
  },
  fields: {
    message_id: required("uuid", "Stable external inbox message."),
    attempt_id: required("uuid", "Exact sender attempt and idempotency key."),
    account_id: required("uuid", "Account-home authority."),
    installation_id: required("uuid", "Exact external installation inbox."),
    agent_session_id: required("uuid", "Authorizing Agent Session."),
    session_generation: required("uuid", "Session generation at admission."),
    source: {
      ...required("map", "Discriminated authenticated source member."),
      pg_type: "JSONB",
    },
    body: required("string", "Explicit agent-provided message body."),
    state: {
      ...required("string", "Pending or acknowledged."),
      pg_default: "'pending'::character varying",
    },
    created_at: created,
    expires_at: {
      ...time("Finite inbox retention deadline."),
      not_null: true,
    },
    acknowledged_at: time("Explicit external acknowledgment time."),
  },
});
