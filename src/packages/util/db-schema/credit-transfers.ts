/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";

Table({
  name: "credit_transfer_ledger_observations",
  rules: { primary_key: "purchase_id", pg_indexes: ["account_id"] },
  fields: {
    purchase_id: { type: "integer", not_null: true },
    account_id: { type: "uuid", not_null: true },
    max_cost: { type: "string", pg_type: "NUMERIC(20,10)", not_null: true },
  },
});

Table({
  name: "credit_payment_roots",
  rules: { primary_key: "root_id", pg_indexes: ["account_id"] },
  fields: {
    root_id: { type: "uuid", not_null: true },
    account_id: { type: "uuid", not_null: true },
    home_bay_id: { type: "string", not_null: true },
    purchase_id: { type: "integer", not_null: true, unique: true },
    original_purchase_id: {
      type: "integer",
      pg_check: "CHECK (original_purchase_id > 0)",
      desc: "Immutable provenance purchase ID before account portability remaps the local purchase_id.",
    },
    payment_intent_id: { type: "string", not_null: true, unique: true },
    amount_usd: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      not_null: true,
      pg_check:
        "CHECK (amount_usd>0 AND amount_usd<10000000000 AND amount_usd=round(amount_usd,2))",
    },
    evidence: { type: "map", pg_type: "JSONB", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "credit_transfers",
  rules: {
    primary_key: "transfer_id",
    pg_indexes: [
      "sender_account_id",
      "recipient_account_id",
      "state, updated_at",
    ],
    pg_constraints: [
      {
        name: "credit_transfers_operation",
        type: "unique",
        columns: ["sender_account_id", "operation_id"],
      },
    ],
  },
  fields: {
    transfer_id: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    sender_account_id: { type: "uuid", not_null: true },
    recipient_account_id: { type: "uuid", not_null: true },
    recipient_home_bay_id: { type: "string", not_null: true },
    terms_hash: { type: "string", not_null: true },
    manifest: { type: "map", pg_type: "JSONB", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (state IN ('pending','received','compensated'))",
    },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "credit_transfer_deliveries",
  rules: { primary_key: "transfer_id", pg_indexes: ["recipient_account_id"] },
  fields: {
    transfer_id: { type: "uuid", not_null: true },
    recipient_account_id: { type: "uuid", not_null: true },
    sender_home_bay_id: { type: "string", not_null: true },
    manifest_hash: { type: "string", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (state IN ('received','rejected'))",
    },
    reason: { type: "string" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "credit_transfer_entries",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "transfer_id"],
    pg_constraints: [
      {
        name: "credit_transfer_entries_leg",
        type: "unique",
        columns: ["transfer_id", "leg"],
      },
      {
        name: "credit_transfer_entries_purchase",
        type: "foreign-key",
        columns: ["purchase_id"],
        references: { table: "purchases", columns: ["id"] },
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    transfer_id: { type: "uuid", not_null: true },
    account_id: { type: "uuid", not_null: true },
    purchase_id: { type: "integer", not_null: true, unique: true },
    leg: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (leg IN ('debit','credit','compensation'))",
    },
    fragments: { type: "map", pg_type: "JSONB", not_null: true },
    receipt: { type: "map", pg_type: "JSONB", not_null: true },
  },
});
