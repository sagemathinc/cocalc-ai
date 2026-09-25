/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "payment_fulfillments",
  rules: {
    primary_key: "payment_id",
    pg_indexes: ["account_id"],
    pg_constraints: [
      {
        name: "payment_fulfillments_credit",
        type: "foreign-key",
        columns: ["credit_id"],
        references: { table: "purchases", columns: ["id"] },
      },
      {
        name: "payment_fulfillments_result",
        type: "check",
        expression:
          "(state='pending' AND result IS NULL) OR (state='fulfilled' AND result IS NOT NULL)",
      },
    ],
  },
  fields: {
    payment_id: { type: "string", not_null: true },
    account_id: { type: "uuid", not_null: true },
    credit_id: { type: "integer", not_null: true, unique: true },
    purpose: { type: "string", not_null: true },
    amount: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      not_null: true,
      pg_check:
        "CHECK (amount > 0 AND amount < 10000000000 AND amount=round(amount,2))",
    },
    request: { type: "map", pg_type: "JSONB", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_default: "'pending'::text",
      pg_check: "CHECK (state IN ('pending','fulfilled'))",
    },
    result: { type: "map", pg_type: "JSONB" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    fulfilled_at: { type: "timestamp" },
  },
});
