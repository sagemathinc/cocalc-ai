/*
 * Admin-assigned memberships (on-prem/dev and commercial comping).
 */

import { Table } from "./types";

Table({
  name: "admin_assigned_memberships",
  rules: {
    primary_key: "account_id",
    pg_indexes: ["membership_class", "expires_at", "assigned_by", "assigned_at"],
    user_query: {
      set: {
        admin: true,
        delete: true,
        fields: {
          account_id: null,
          membership_class: null,
          assigned_by: null,
          assigned_at: null,
          expires_at: null,
          notes: null,
        },
      },
      get: {
        admin: true,
        fields: {
          account_id: null,
          membership_class: null,
          assigned_by: null,
          assigned_at: null,
          expires_at: null,
          notes: null,
        },
      },
    },
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account receiving the admin-assigned membership.",
      render: { type: "account" },
    },
    membership_class: {
      type: "string",
      desc: "Membership tier id to apply.",
    },
    assigned_by: {
      type: "uuid",
      desc: "Admin account that assigned this membership.",
      render: { type: "account" },
    },
    assigned_at: {
      type: "timestamp",
      desc: "When the admin assignment was made.",
    },
    expires_at: {
      type: "timestamp",
      desc: "Optional expiration time for this admin assignment.",
    },
    notes: {
      type: "string",
      desc: "Optional admin notes.",
    },
  },
});
