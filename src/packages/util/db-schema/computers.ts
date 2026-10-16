/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Computers: machines an account connects to one of its projects, so that
// project can run commands there. Design:
// src/.agents/computers-direct-host-2026-10-16.md. Control-plane data at the
// account's home bay; commands never pass through it.

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

Table({
  name: "paired_computers",
  rules: {
    primary_key: "computer_id",
    pg_custom_indexes: [
      {
        name: "paired_computers_account_name",
        unique: true,
        query: "(account_id,name) WHERE revoked_at IS NULL",
      },
      {
        name: "paired_computers_token_hash",
        unique: true,
        query: "(token_hash)",
      },
      {
        name: "paired_computers_project",
        query: "(project_id) WHERE revoked_at IS NULL",
      },
    ],
  },
  fields: {
    computer_id: required("uuid", "Stable computer id."),
    account_id: required("uuid", "Owning account."),
    project_id: required(
      "uuid",
      "The one project whose processes may run commands here.",
    ),
    name: required("string", "Alias, unique per account (@name)."),
    hostname: required("string", "Machine hostname at pairing."),
    os: required("string", "Machine OS at pairing."),
    arch: required("string", "Machine architecture at pairing."),
    machine_user: required("string", "OS user the connector runs as."),
    token_hash: required(
      "string",
      "sha256 of the computer's secret token (the computer alone has the token).",
    ),
    request_id: required("string", "Pairing request that created it."),
    created_at: created("Pairing approval time."),
    connected_at: timestamp("Last time the computer asked for a host token."),
    revoked_at: timestamp(
      "Revoked: no more host tokens, and dropped by its host.",
    ),
  },
});

Table({
  name: "computer_pairing_requests",
  rules: {
    primary_key: "request_id",
    pg_constraints: [
      {
        name: "computer_pairing_requests_state_check",
        type: "check",
        expression:
          "state IN ('pending','claimed','approved','declined','expired','invalidated')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "computer_pairing_requests_account",
        query: "(account_id,created_at DESC)",
      },
    ],
  },
  fields: {
    request_id: required("string", "Non-secret request id (R-XXXXXXXXXX)."),
    account_id: required("uuid", "Account the computer will belong to."),
    project_id: required("uuid", "Project the computer will be attached to."),
    name: required("string", "Requested alias."),
    state: required(
      "string",
      "pending, claimed, approved, declined, expired, invalidated.",
    ),
    claims: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      desc: "Claim attempts; a second one invalidates the request.",
    },
    token_hash: optional(
      "string",
      "sha256 of the secret the claiming machine got (its token once approved).",
    ),
    pairing_phrase: optional(
      "string",
      "Four words shown on the machine and to the owner.",
    ),
    hostname: optional("string", "Claiming machine's hostname."),
    os: optional("string", "Claiming machine's OS."),
    arch: optional("string", "Claiming machine's architecture."),
    machine_user: optional("string", "Claiming machine's OS user."),
    computer_id: optional("uuid", "Computer created by approval."),
    expires_at: { ...timestamp("Request expiry."), not_null: true },
    created_at: created("Request time."),
  },
});
