/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "compute_vm_turn_grants",
  rules: {
    primary_key: "grant_id",
    pg_indexes: [
      "secret_hash",
      "owner_account_id",
      "project_id",
      "turn_id",
      "session_id",
      "expires_at",
      "revoked_at",
    ],
  },
  fields: {
    grant_id: { type: "uuid", desc: "Durable managed-compute grant ID." },
    secret_hash: {
      type: "string",
      unique: true,
      desc: "SHA-256 fingerprint of the short-lived ACP bearer; plaintext is never stored.",
    },
    owner_account_id: { type: "uuid", desc: "Account owning the grant." },
    project_id: { type: "uuid", desc: "Only project accessible to the grant." },
    turn_id: {
      type: "string",
      desc: "ACP turn or bounded token-turn identity.",
    },
    session_id: { type: "string", desc: "ACP session identity." },
    issued_by_account_id: { type: "uuid", desc: "Human issuer." },
    allowed_actions: { type: "array", pg_type: "TEXT[]" },
    allowed_vm_ids: { type: "array", pg_type: "UUID[]" },
    allow_create: { type: "boolean" },
    allowed_providers: { type: "array", pg_type: "TEXT[]" },
    allowed_machine_classes: { type: "array", pg_type: "TEXT[]" },
    funding_mode: { type: "string" },
    max_active_vms: { type: "number" },
    max_hourly_usd: { type: "number" },
    max_total_authorized_usd: { type: "number" },
    max_ttl_minutes: { type: "number" },
    expires_at: { type: "timestamp" },
    revoked_at: { type: "timestamp" },
    created_at: { type: "timestamp" },
    last_used_at: { type: "timestamp" },
    metadata: { type: "map", desc: "Bounded issuance and audit metadata." },
  },
});
