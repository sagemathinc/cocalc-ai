/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";

// Account-home only. Project IDs are locators, not local foreign keys.
Table({
  name: "personal_library_controls",
  rules: { primary_key: "account_id" },
  fields: { account_id: { type: "uuid", not_null: true } },
});

Table({
  name: "personal_library_aliases",
  rules: {
    primary_key: ["account_id", "name"],
    pg_custom_indexes: [
      {
        name: "personal_library_current_target",
        unique: true,
        query: "(account_id,project_id,entry_id) WHERE active",
      },
    ],
  },
  fields: {
    account_id: { type: "uuid", not_null: true },
    name: { type: "string", not_null: true },
    project_id: { type: "uuid", not_null: true },
    entry_id: { type: "string", not_null: true },
    active: { type: "boolean", not_null: true, pg_default: "true" },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

Table({
  name: "personal_library_pins",
  rules: {
    primary_key: ["account_id", "pin_key"],
    pg_indexes: ["account_id, rank"],
  },
  fields: {
    account_id: { type: "uuid", not_null: true },
    pin_key: { type: "string", not_null: true },
    rank: { type: "integer", pg_type: "BIGINT", not_null: true },
  },
});

Table({
  name: "personal_library_imports",
  rules: { primary_key: "account_id" },
  fields: {
    account_id: { type: "uuid", not_null: true },
    imported_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});
