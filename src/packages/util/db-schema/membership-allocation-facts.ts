/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_allocation_facts",
  rules: {
    primary_key: "fact_key",
    pg_indexes: [
      "occurred_at",
      "bay_id",
      "account_id",
      "channel",
      "membership_class",
      "purchase_id",
      "subscription_id",
      "reverses_fact_key",
    ],
  },
  fields: {
    fact_key: {
      type: "string",
      pg_type: "VARCHAR(256)",
      desc: "Stable idempotency key for this immutable membership allocation fact.",
    },
    occurred_at: {
      type: "timestamp",
      desc: "When the source membership action occurred.",
      not_null: true,
    },
    bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Account-home bay that recorded this fact.",
      not_null: true,
    },
    account_id: {
      type: "uuid",
      desc: "Account used only for source reconciliation and idempotency.",
      render: { type: "account" },
      not_null: true,
    },
    channel: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Membership channel such as personal, direct-student, course, team, or site.",
      not_null: true,
      pg_check:
        "CHECK (channel IN ('personal','direct-student','course','team','site'))",
    },
    source_kind: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Source operation such as purchase, refund, trial, plan-change, plan-change-credit, assignment, correction, or external-import.",
      not_null: true,
      pg_check:
        "CHECK (source_kind IN ('purchase','refund','trial','plan-change','plan-change-credit','assignment','correction','external-import'))",
    },
    membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Stable membership tier id allocated by this fact.",
      not_null: true,
    },
    billing_interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Trial, monthly, annual, or fixed-term allocation interval.",
      not_null: true,
      pg_check: "CHECK (billing_interval IN ('trial','month','year','fixed'))",
    },
    lifecycle: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Trial, first paid period, renewal, or plan change.",
      not_null: true,
      pg_check:
        "CHECK (lifecycle IN ('trial','first_paid','renewal','plan_change'))",
    },
    previous_membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Previous membership tier for a plan change.",
    },
    previous_billing_interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Previous billing interval for a plan change.",
    },
    tier_change: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Upgrade, downgrade, or same-tier transition classification.",
      not_null: true,
      pg_check: "CHECK (tier_change IN ('none','upgrade','downgrade','same'))",
    },
    allocation_start: {
      type: "timestamp",
      pg_type: "date",
      desc: "First UTC date included in the allocation.",
      not_null: true,
    },
    allocation_end: {
      type: "timestamp",
      pg_type: "date",
      desc: "First UTC date excluded from the allocation.",
      not_null: true,
      pg_check: "CHECK (allocation_end > allocation_start)",
    },
    active_memberships: {
      type: "integer",
      desc: "Signed membership-product count allocated to every included day.",
      not_null: true,
    },
    purchased_capacity: {
      type: "integer",
      desc: "Signed purchased-seat capacity allocated to every included day.",
      not_null: true,
    },
    revenue_cents: {
      type: "number",
      pg_type: "bigint",
      desc: "Signed whole-cent revenue distributed exactly across the allocation period.",
      not_null: true,
    },
    purchase_id: {
      type: "integer",
      desc: "Related CoCalc purchase id, when applicable.",
    },
    subscription_id: {
      type: "integer",
      desc: "Related personal membership subscription id, when applicable.",
    },
    reverses_fact_key: {
      type: "string",
      pg_type: "VARCHAR(256)",
      desc: "Original allocation fact reversed by this compensating fact.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this immutable fact was recorded.",
      pg_default: "now()",
      not_null: true,
    },
  },
});
