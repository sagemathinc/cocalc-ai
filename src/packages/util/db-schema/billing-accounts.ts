/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "billing_accounts",
  rules: {
    primary_key: "account_id",
    pg_indexes: ["stripe_customer_id", "home_bay_id", "updated_at"],
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Stable account identity for seed-authoritative financial state.",
    },
    home_bay_id: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Current account home used only for projections and lifecycle routing.",
    },
    stripe_customer_id: {
      type: "string",
      pg_type: "varchar(256)",
      unique: true,
      desc: "Stripe customer mapped to this account.",
    },
    stripe_customer: {
      type: "map",
      desc: "Legacy cached Stripe customer data retained during billing migration.",
    },
    coupon_history: { type: "map" },
    purchase_closing_day: { type: "integer" },
    balance: {
      type: "number",
      pg_type: "numeric(20,10)",
      desc: "Cached display balance; purchases remain authoritative.",
    },
    auto_balance: { type: "map" },
    stripe_checkout_session: { type: "map" },
    stripe_usage_subscription: {
      type: "string",
      pg_type: "varchar(256)",
    },
    monthly_collection: { type: "map" },
    banned: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Last seed-observed account ban state; authority fences remain decisive.",
    },
    banned_at: {
      type: "timestamp",
      desc: "Last observed ban transition, when available.",
    },
    deleted: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Last seed-observed account deletion state; authority fences remain decisive.",
    },
    created_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
    },
    updated_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
    },
  },
});
