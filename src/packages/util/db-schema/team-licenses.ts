/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "team_licenses",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "owner_account_id",
      "status",
      "current_period_end",
      "last_renewal_attempt_at",
      "updated",
    ],
    pg_unique_indexes: ["owner_account_id"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          owner_account_id: null,
          status: null,
          current_period_start: null,
          current_period_end: null,
          latest_purchase_id: null,
          payment: null,
          last_renewal_attempt_at: null,
          last_renewal_notice_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          owner_account_id: null,
          status: null,
          current_period_start: null,
          current_period_end: null,
          latest_purchase_id: null,
          payment: null,
          last_renewal_attempt_at: null,
          last_renewal_notice_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique team-license id.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Account that owns and pays for this team license.",
      render: { type: "account" },
    },
    status: {
      type: "string",
      desc: "Team-license billing status: active, past_due, or canceled.",
    },
    current_period_start: {
      type: "timestamp",
      desc: "Start of the current paid billing period.",
    },
    current_period_end: {
      type: "timestamp",
      desc: "End of the current paid billing period.",
    },
    latest_purchase_id: {
      type: "number",
      desc: "Latest purchase that changed or renewed this team license.",
    },
    payment: {
      type: "map",
      desc: "Outstanding renewal payment state, if any.",
    },
    last_renewal_attempt_at: {
      type: "timestamp",
      desc: "Most recent automatic renewal attempt.",
    },
    last_renewal_notice_at: {
      type: "timestamp",
      desc: "Most recent renewal failure notice.",
    },
    metadata: {
      type: "map",
      desc: "Optional team-license metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "team_license_seat_lines",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "team_license_id",
      "owner_account_id",
      "membership_class",
      "package_id",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          team_license_id: null,
          owner_account_id: null,
          membership_class: null,
          package_id: null,
          seat_count: null,
          annual_price_per_seat: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          team_license_id: null,
          owner_account_id: null,
          membership_class: null,
          package_id: null,
          seat_count: null,
          annual_price_per_seat: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique team-license seat line id.",
    },
    team_license_id: {
      type: "uuid",
      desc: "Parent team license.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Denormalized team-license owner for account-home routing.",
      render: { type: "account" },
    },
    membership_class: {
      type: "string",
      desc: "Membership tier for this seat line.",
    },
    package_id: {
      type: "uuid",
      desc: "Backing membership package used for assignments and grants.",
    },
    seat_count: {
      type: "number",
      desc: "Purchased seats for this tier.",
    },
    annual_price_per_seat: {
      type: "number",
      desc: "Annual seat price in USD used for the latest change.",
    },
    metadata: {
      type: "map",
      desc: "Optional team-license seat line metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});
