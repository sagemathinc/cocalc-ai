/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { MoneyValue } from "@cocalc/util/money";

export type SubscriptionRenewalAttemptState =
  | "scheduled"
  | "processing"
  | "succeeded"
  | "failed"
  | "canceled";

export interface SubscriptionRenewalAttempt {
  id: string;
  subscription_id: number;
  account_id: string;
  period_end: Date;
  target_period_end: Date;
  amount: MoneyValue;
  balance_applied?: MoneyValue | null;
  funding_version?: number | null;
  state: SubscriptionRenewalAttemptState;
  not_before: Date;
  next_attempt_at: Date;
  lease_expires_at?: Date;
  last_attempt_at?: Date;
  attempt_count: number;
  stripe_invoice_id?: string;
  payment_intent_id?: string;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
  completed_at?: Date;
}

Table({
  name: "subscription_renewal_attempts",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "account_id",
      "subscription_id",
      "state",
      "not_before",
      "next_attempt_at",
      "lease_expires_at",
      "updated_at",
    ],
    pg_unique_indexes: ["(subscription_id,period_end)", "payment_intent_id"],
    pg_constraints: [
      {
        name: "subscription_renewal_attempts_balance_allocation",
        type: "check",
        expression:
          "balance_applied IS NULL OR (balance_applied >= 0 AND (balance_applied = 0 OR balance_applied < amount) AND balance_applied = round(balance_applied, 2))",
      },
    ],
    pg_custom_indexes: [
      {
        name: "subscription_renewal_attempts_one_open_idx",
        query: "(subscription_id) WHERE state IN ('scheduled','processing')",
        unique: true,
      },
      {
        name: "subscription_renewal_attempts_claim_idx",
        query:
          "(next_attempt_at,not_before) WHERE state IN ('scheduled','processing')",
      },
    ],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Stable identifier and Stripe idempotency identity for this renewal.",
    },
    subscription_id: {
      type: "integer",
      desc: "Personal membership subscription being renewed.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns and pays for the subscription.",
      render: { type: "account" },
    },
    period_end: {
      type: "timestamp",
      desc: "Paid-through boundary this attempt renews.",
    },
    target_period_end: {
      type: "timestamp",
      desc: "New paid-through boundary after successful renewal.",
    },
    amount: {
      type: "number",
      pg_type: "numeric(20,10)",
      desc: "Renewal charge in US dollars.",
    },
    balance_applied: {
      type: "number",
      pg_type: "numeric(20,10)",
      desc: "Prepaid credit reserved while this attempt is scheduled or processing, before any Stripe payment is created. Null means the funding decision has not been made. Terminal attempts retain the historical split but no longer hold credit.",
    },
    funding_version: {
      type: "integer",
      desc: "Version of the funding decision algorithm. Null preserves full-card compatibility for attempts that may predate durable split funding.",
    },
    state: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Scheduled, processing, succeeded, failed, or canceled.",
    },
    not_before: {
      type: "timestamp",
      desc: "The paid period must end before a worker can collect payment.",
    },
    next_attempt_at: {
      type: "timestamp",
      desc: "Earliest time a worker may claim or retry this attempt.",
    },
    lease_expires_at: {
      type: "timestamp",
      desc: "Worker lease deadline for crash-safe parallel processing.",
    },
    last_attempt_at: {
      type: "timestamp",
      desc: "When a worker last attempted this renewal.",
    },
    attempt_count: {
      type: "integer",
      desc: "Number of worker claims for this renewal.",
    },
    stripe_invoice_id: {
      type: "string",
      desc: "Stripe invoice created with this attempt's idempotency identity.",
    },
    payment_intent_id: {
      type: "string",
      desc: "Stripe PaymentIntent bound to this renewal attempt.",
    },
    last_error: {
      type: "string",
      desc: "Most recent processing or reconciliation error.",
    },
    created_at: {
      type: "timestamp",
      desc: "When this renewal was scheduled.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this renewal state last changed.",
    },
    completed_at: {
      type: "timestamp",
      desc: "When this renewal reached a terminal state.",
    },
  },
});
