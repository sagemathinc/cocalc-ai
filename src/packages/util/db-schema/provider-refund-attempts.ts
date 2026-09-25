/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "provider_refund_attempts",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "state"],
    pg_custom_indexes: [
      {
        name: "provider_refund_attempts_reconcile_due",
        query: "(next_reconcile_at) WHERE state='pending'",
      },
    ],
    pg_constraints: [
      {
        name: "provider_refund_attempts_purchase",
        type: "foreign-key",
        columns: ["purchase_id"],
        references: { table: "purchases", columns: ["id"] },
      },
      {
        name: "provider_refund_attempts_reversal",
        type: "foreign-key",
        columns: ["refund_purchase_id"],
        references: { table: "purchases", columns: ["id"] },
      },
      {
        name: "provider_refund_attempts_terminal",
        type: "check",
        expression:
          "(state='pending' AND refund_purchase_id IS NULL AND completed_at IS NULL) OR (state='succeeded' AND refund_purchase_id IS NOT NULL AND completed_at IS NOT NULL) OR (state='failed' AND refund_purchase_id IS NULL AND completed_at IS NOT NULL)",
      },
      {
        name: "provider_refund_attempts_dispatch",
        type: "check",
        expression: "(provider_request IS NULL) = (dispatched_at IS NULL)",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    purchase_id: { type: "integer", not_null: true, unique: true },
    account_id: { type: "uuid", not_null: true },
    invoice_id: { type: "string", not_null: true },
    amount: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      not_null: true,
      pg_check:
        "CHECK (amount > 0 AND amount < 10000000000 AND amount=round(amount,2))",
    },
    request: { type: "map", pg_type: "JSONB", not_null: true },
    provider_request: { type: "map", pg_type: "JSONB" },
    previous_refunded_cents: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (previous_refunded_cents >= 0)",
    },
    provider_result: { type: "map", pg_type: "JSONB" },
    state: {
      type: "string",
      not_null: true,
      pg_default: "'pending'::text",
      pg_check: "CHECK (state IN ('pending','succeeded','failed'))",
    },
    refund_purchase_id: { type: "integer", unique: true },
    created_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "clock_timestamp()",
    },
    dispatched_at: { type: "timestamp" },
    completed_at: { type: "timestamp" },
    reconcile_token: { type: "uuid" },
    reconcile_lease_expires_at: { type: "timestamp" },
    next_reconcile_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "clock_timestamp()",
    },
    reconcile_attempts: {
      type: "integer",
      not_null: true,
      pg_default: "0",
      pg_check: "CHECK (reconcile_attempts >= 0)",
    },
    last_reconcile_error: { type: "string" },
  },
});
