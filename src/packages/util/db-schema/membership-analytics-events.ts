/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_analytics_events",
  rules: {
    primary_key: "event_key",
    pg_indexes: [
      "event_time",
      "event_type",
      "bay_id",
      "account_id",
      "membership_class",
      "subscription_id",
      "purchase_id",
    ],
  },
  fields: {
    event_key: {
      type: "string",
      pg_type: "VARCHAR(192)",
      desc: "Stable idempotency key for this membership analytics event.",
    },
    event_type: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Membership analytics event type, e.g. membership_created, purchase_completed, membership_canceled, or trial_started.",
    },
    event_time: {
      type: "timestamp",
      desc: "When the event happened.",
    },
    bay_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Bay that recorded this account-home analytics event.",
    },
    account_id: {
      type: "uuid",
      desc: "Account associated with the event.",
      render: { type: "account" },
    },
    membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Membership tier id associated with this event.",
    },
    previous_membership_class: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Previous membership tier id for switch events, if known.",
    },
    source: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Event source category such as subscription, purchase, trial, or refund.",
    },
    interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Membership billing interval for paid subscription events.",
    },
    subscription_id: {
      type: "integer",
      desc: "Related subscription id, if any.",
    },
    purchase_id: {
      type: "integer",
      desc: "Related purchase id, if any.",
    },
    amount: {
      type: "number",
      pg_type: "numeric(20,10)",
      desc: "Event amount in USD, positive for revenue and negative for refunds.",
    },
    period_start: {
      type: "timestamp",
      desc: "Membership period start associated with this event, if applicable.",
    },
    period_end: {
      type: "timestamp",
      desc: "Membership period end associated with this event, if applicable.",
    },
    trial_days: {
      type: "integer",
      desc: "Trial length for trial-related events.",
    },
    trial_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Trial classification such as none, started, converted, or canceled.",
    },
    metadata: {
      type: "map",
      desc: "Additional source-specific analytics metadata.",
    },
    created_at: {
      type: "timestamp",
      desc: "When the analytics row was inserted.",
    },
  },
});
