/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "admin_membership_package_intents",
  rules: {
    primary_key: "invoice_id",
    pg_indexes: ["account_id", "admin_account_id", "created_at"],
  },
  fields: {
    invoice_id: {
      type: "string",
      not_null: true,
      desc: "Stable admin purchase identity consumed by the final membership purchase.",
    },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "Account that will own and pay for the approved package.",
      render: { type: "account" },
    },
    admin_account_id: {
      type: "uuid",
      not_null: true,
      desc: "Administrator that approved the immutable fulfillment snapshot.",
      render: { type: "account" },
    },
    request_hash: {
      type: "string",
      pg_type: "VARCHAR(64)",
      not_null: true,
      desc: "SHA-256 of the normalized caller request for idempotency validation.",
    },
    snapshot: {
      type: "map",
      not_null: true,
      desc: "Immutable validated quote, dates, price, metadata, and audit context approved before provider funding.",
    },
    created_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "When the fulfillment intent was durably approved.",
    },
    updated_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "Last reconciliation update for this intent.",
    },
  },
});
