/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// One row per purchase refused because a customer in the EU or the UK has no
// valid VAT ID (see util/stripe/business-tax-id.ts), so lost sales can be
// counted.
Table({
  name: "business_tax_id_refusals",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "created"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          account_id: null,
          country: null,
          path: null,
          reason: null,
          amount: null,
          created: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique refusal id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account whose purchase was refused.",
      render: { type: "account" },
    },
    country: {
      type: "string",
      pg_type: "VARCHAR(2)",
      desc: "Billing country of the Stripe customer.",
    },
    path: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Where the purchase was refused, e.g. checkout or the payment purpose.",
    },
    reason: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "missing or unverified.",
    },
    amount: {
      type: "number",
      pg_type: "NUMERIC(20,10)",
      desc: "Amount in USD excluding tax, when known.",
    },
    created: {
      type: "timestamp",
      desc: "When the purchase was refused.",
    },
  },
});
