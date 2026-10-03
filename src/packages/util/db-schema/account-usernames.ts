/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";

// Seed-global identities. Accounts may live on another bay, so no local FK.
Table({
  name: "account_usernames",
  rules: {
    primary_key: "username",
    pg_indexes: ["account_id"],
    pg_custom_indexes: [
      {
        name: "account_usernames_current",
        unique: true,
        query: "(account_id) WHERE active",
      },
    ],
  },
  fields: {
    username: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (username = lower(username) AND length(username) BETWEEN 1 AND 39)",
    },
    account_id: { type: "uuid", not_null: true },
    active: { type: "boolean", not_null: true, pg_default: "true" },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "account_username_release_log",
  rules: { primary_key: "id", pg_indexes: ["owner_account_id", "created"] },
  fields: {
    id: { type: "uuid", not_null: true },
    owner_account_id: { type: "uuid", not_null: true },
    actor_account_id: { type: "uuid", not_null: true },
    username: { type: "string", not_null: true },
    reason: { type: "string", not_null: true },
    created: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});
