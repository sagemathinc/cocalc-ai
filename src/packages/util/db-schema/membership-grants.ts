/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "membership_grants",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "account_id",
      "membership_class",
      "source",
      "package_id",
      "purchase_id",
      "starts_at",
      "expires_at",
      "revoked_at",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          account_id: null,
          membership_class: null,
          source: null,
          package_id: null,
          purchase_id: null,
          granted_by_account_id: null,
          starts_at: null,
          expires_at: null,
          revoked_at: null,
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
          account_id: null,
          membership_class: null,
          source: null,
          package_id: null,
          purchase_id: null,
          granted_by_account_id: null,
          starts_at: null,
          expires_at: null,
          revoked_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique membership grant id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account receiving the granted membership.",
      render: { type: "account" },
    },
    membership_class: {
      type: "string",
      desc: "Membership tier id granted to the account.",
    },
    source: {
      type: "string",
      desc: "Why this grant exists, e.g. student-pay, course-seat, team-seat, domain-license, or site-license.",
    },
    package_id: {
      type: "uuid",
      desc: "Optional membership package that this grant was assigned from.",
    },
    purchase_id: {
      type: "number",
      desc: "Optional purchase that funded this grant.",
    },
    granted_by_account_id: {
      type: "uuid",
      desc: "Optional account that granted or assigned this membership.",
      render: { type: "account" },
    },
    starts_at: {
      type: "timestamp",
      desc: "When this grant becomes active.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this grant stops being active, if applicable.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this grant was revoked before expiration, if applicable.",
    },
    metadata: {
      type: "map",
      desc: "Optional source-specific metadata for the grant.",
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
  name: "membership_packages",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "owner_account_id",
      "kind",
      "membership_class",
      "purchase_id",
      "starts_at",
      "expires_at",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          owner_account_id: null,
          kind: null,
          membership_class: null,
          seat_count: null,
          purchase_id: null,
          starts_at: null,
          expires_at: null,
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
          kind: null,
          membership_class: null,
          seat_count: null,
          purchase_id: null,
          starts_at: null,
          expires_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique membership package id.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Account that owns and pays for this package.",
      render: { type: "account" },
    },
    kind: {
      type: "string",
      desc: "Package type, e.g. course, team, domain, or site.",
    },
    membership_class: {
      type: "string",
      desc: "Membership tier granted by seats in this package.",
    },
    seat_count: {
      type: "number",
      desc: "Number of seats currently included in this package.",
    },
    purchase_id: {
      type: "number",
      desc: "Optional purchase that created this package.",
    },
    starts_at: {
      type: "timestamp",
      desc: "When this package becomes active.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this package stops being active, if applicable.",
    },
    metadata: {
      type: "map",
      desc: "Optional package metadata such as course linkage or domain policy.",
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
  name: "membership_package_assignments",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "package_id",
      "account_id",
      "assigned_by_account_id",
      "assigned_at",
      "revoked_at",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          package_id: null,
          account_id: null,
          assigned_by_account_id: null,
          assigned_at: null,
          revoked_at: null,
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
          package_id: null,
          account_id: null,
          assigned_by_account_id: null,
          assigned_at: null,
          revoked_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique membership package assignment id.",
    },
    package_id: {
      type: "uuid",
      desc: "Package providing the seat.",
    },
    account_id: {
      type: "uuid",
      desc: "Account assigned to the seat.",
      render: { type: "account" },
    },
    assigned_by_account_id: {
      type: "uuid",
      desc: "Account that made the assignment.",
      render: { type: "account" },
    },
    assigned_at: {
      type: "timestamp",
      desc: "When the seat was assigned.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When the seat assignment was revoked, if applicable.",
    },
    metadata: {
      type: "map",
      desc: "Optional assignment metadata.",
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
