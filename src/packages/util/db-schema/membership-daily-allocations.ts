/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_daily_allocations",
  rules: {
    primary_key: [
      "day",
      "bay_id",
      "channel",
      "source_kind",
      "membership_class",
      "billing_interval",
      "lifecycle",
      "previous_membership_class",
      "previous_billing_interval",
      "tier_change",
    ],
    pg_indexes: [
      "day",
      "bay_id",
      "channel",
      "membership_class",
      "billing_interval",
      "lifecycle",
    ],
  },
  fields: {
    day: {
      type: "timestamp",
      pg_type: "date",
      desc: "UTC date represented by this derived allocation row.",
    },
    bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Bay whose immutable facts contributed to this row.",
    },
    channel: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Membership business channel.",
    },
    source_kind: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Source operation category retained for reconciliation.",
    },
    membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Membership tier id.",
    },
    billing_interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Trial, monthly, annual, or fixed-term interval.",
    },
    lifecycle: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Trial, first paid period, renewal, or plan change.",
    },
    previous_membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Previous tier or an empty string when not applicable.",
    },
    previous_billing_interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Previous interval or an empty string when not applicable.",
    },
    tier_change: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Upgrade, downgrade, same, or none.",
    },
    active_memberships: {
      type: "integer",
      desc: "Net allocated membership-product count.",
      not_null: true,
    },
    purchased_capacity: {
      type: "integer",
      desc: "Net allocated purchased-seat capacity.",
      not_null: true,
    },
    revenue_cents: {
      type: "number",
      pg_type: "bigint",
      desc: "Net whole-cent revenue allocated to this day.",
      not_null: true,
    },
    fact_count: {
      type: "integer",
      desc: "Number of signed facts incorporated for reconciliation.",
      not_null: true,
    },
    created_at: {
      type: "timestamp",
      desc: "When this aggregate key was first created.",
      pg_default: "now()",
      not_null: true,
    },
    updated_at: {
      type: "timestamp",
      desc: "When this aggregate key was last adjusted.",
      pg_default: "now()",
      not_null: true,
    },
  },
});
