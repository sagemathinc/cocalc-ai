/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "admin_membership_orders",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id"],
    pg_constraints: [
      {
        name: "admin_membership_orders_operation",
        type: "unique",
        columns: ["admin_account_id", "idempotency_key"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    account_id: { type: "uuid", not_null: true },
    admin_account_id: { type: "uuid", not_null: true },
    idempotency_key: { type: "string", not_null: true },
    request: { type: "map", pg_type: "JSONB", not_null: true },
    quote: { type: "map", pg_type: "JSONB", not_null: true },
    created_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "clock_timestamp()",
    },
    dispatched_at: { type: "timestamp" },
    payment_intent_id: { type: "string", unique: true },
    stripe_invoice_id: { type: "string", unique: true },
  },
});
