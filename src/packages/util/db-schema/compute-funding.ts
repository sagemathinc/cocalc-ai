/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { FieldSpec, Fields, PgTableConstraint } from "./types";

function amount(column: string): FieldSpec {
  return {
    type: "string",
    pg_type: "NUMERIC(20,10)",
    not_null: true,
    pg_default: "0",
    pg_check: `CHECK (${column} >= 0 AND ${column} < 10000000000)`,
  };
}

function budgetFields(): Fields {
  return {
    authorized_usd: amount("authorized_usd"),
    spent_usd: amount("spent_usd"),
    reserved_usd: amount("reserved_usd"),
    released_usd: amount("released_usd"),
  };
}

function budgetConstraint(name: string): PgTableConstraint {
  return {
    name,
    type: "check",
    expression:
      "authorized_usd > 0 AND spent_usd + reserved_usd + released_usd <= authorized_usd",
  };
}

function timestamps(): Fields {
  return {
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    updated_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  };
}

// Deliberately no user_query rules: course files and clients cannot mutate money.
Table({
  name: "account_funding_authorities",
  rules: { primary_key: "payer_account_id" },
  fields: {
    payer_account_id: { type: "uuid", not_null: true },
    epoch: { type: "uuid", not_null: true, unique: true },
    home_bay_id: { type: "string", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (state IN ('active','frozen','retired'))",
    },
    ...timestamps(),
  },
});

Table({
  name: "account_funding_holds",
  rules: {
    primary_key: "id",
    pg_indexes: ["payer_account_id"],
    pg_constraints: [
      {
        name: "account_funding_holds_source",
        type: "unique",
        columns: ["payer_account_id", "source_kind", "source_id"],
      },
      {
        name: "account_funding_holds_remaining",
        type: "check",
        expression: "authorized_usd > 0 AND remaining_usd <= authorized_usd",
      },
      {
        name: "account_funding_holds_owner_lane",
        type: "unique",
        columns: ["id", "payer_account_id", "lane"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    source_kind: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (source_kind IN ('course-pool', 'resource', 'transfer'))",
    },
    source_id: { type: "uuid", not_null: true },
    lane: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (lane IN ('prepaid', 'postpaid'))",
    },
    currency: {
      type: "string",
      not_null: true,
      pg_default: "'USD'::text",
      pg_check: "CHECK (currency = 'USD')",
    },
    authorized_usd: amount("authorized_usd"),
    remaining_usd: amount("remaining_usd"),
    ...timestamps(),
  },
});

Table({
  name: "compute_funding_pools",
  rules: {
    primary_key: "id",
    pg_indexes: ["payer_account_id", "course_project_id", "ends_at", "state"],
    pg_constraints: [
      budgetConstraint("compute_funding_pools_budget"),
      {
        name: "compute_funding_pools_dates",
        type: "check",
        expression: "starts_at < ends_at",
      },
      {
        name: "compute_funding_pools_operation",
        type: "unique",
        columns: ["payer_account_id", "operation_id"],
      },
      {
        name: "compute_funding_pools_hold",
        type: "foreign-key",
        columns: ["hold_id", "payer_account_id", "lane"],
        references: {
          table: "account_funding_holds",
          columns: ["id", "payer_account_id", "lane"],
        },
      },
      {
        name: "compute_funding_pools_owner",
        type: "unique",
        columns: ["id", "payer_account_id"],
      },
      {
        name: "compute_funding_pools_closed",
        type: "check",
        expression:
          "state <> 'closed' OR (reserved_usd = 0 AND spent_usd + released_usd = authorized_usd)",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    course_project_id: { type: "uuid", not_null: true },
    course_instance_id: { type: "uuid", not_null: true },
    hold_id: { type: "uuid", not_null: true, unique: true },
    operation_id: { type: "uuid", not_null: true },
    request_hash: { type: "string", not_null: true },
    currency: {
      type: "string",
      not_null: true,
      pg_default: "'USD'::text",
      pg_check: "CHECK (currency = 'USD')",
    },
    lane: {
      type: "string",
      not_null: true,
      pg_check: "CHECK (lane IN ('prepaid', 'postpaid'))",
    },
    ...budgetFields(),
    // The independently approved maximum is separate from the currently held
    // budget, so a reduced live pool can be restored without reauthorization.
    approval_limit_usd: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      pg_check:
        "CHECK (approval_limit_usd IS NULL OR (approval_limit_usd > 0 AND approval_limit_usd < 10000000000))",
    },
    approval_starts_at: { type: "timestamp" },
    approval_ends_at: { type: "timestamp" },
    allow_overcommit: { type: "boolean", not_null: true, pg_default: "false" },
    starts_at: { type: "timestamp", not_null: true },
    ends_at: { type: "timestamp", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (state IN ('scheduled', 'active', 'suspended', 'closing', 'closed'))",
    },
    version: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      pg_check: "CHECK (version > 0)",
    },
    ...timestamps(),
  },
});

Table({
  name: "compute_funding_grants",
  rules: {
    primary_key: "id",
    pg_indexes: ["pool_id", "beneficiary_account_id", "ends_at"],
    pg_constraints: [
      budgetConstraint("compute_funding_grants_budget"),
      {
        name: "compute_funding_grants_dates",
        type: "check",
        expression: "starts_at < ends_at",
      },
      {
        name: "compute_funding_grants_recipient",
        type: "unique",
        columns: ["pool_id", "beneficiary_account_id"],
      },
      {
        name: "compute_funding_grants_pool_identity",
        type: "unique",
        columns: ["id", "pool_id"],
      },
      {
        name: "compute_funding_grants_pool",
        type: "foreign-key",
        columns: ["pool_id"],
        references: { table: "compute_funding_pools", columns: ["id"] },
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    pool_id: { type: "uuid", not_null: true },
    beneficiary_account_id: { type: "uuid", not_null: true },
    ...budgetFields(),
    starts_at: { type: "timestamp", not_null: true },
    ends_at: { type: "timestamp", not_null: true },
    state: {
      type: "string",
      not_null: true,
      pg_check:
        "CHECK (state IN ('scheduled', 'active', 'exhausted', 'expired', 'revoked'))",
    },
    version: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      pg_check: "CHECK (version > 0)",
    },
    ...timestamps(),
  },
});

// Each independently confirmed amount/date combination remains a distinct
// rectangle.  Combining maxima from separate confirmations would authorize a
// combination the payer never reviewed.
Table({
  name: "compute_funding_pool_approvals",
  rules: {
    primary_key: "id",
    pg_indexes: ["pool_id", "payer_account_id"],
    pg_constraints: [
      {
        name: "compute_funding_pool_approvals_dates",
        type: "check",
        expression: "starts_at < ends_at",
      },
      {
        name: "compute_funding_pool_approvals_pool",
        type: "foreign-key",
        columns: ["pool_id", "payer_account_id"],
        references: {
          table: "compute_funding_pools",
          columns: ["id", "payer_account_id"],
        },
      },
      {
        name: "compute_funding_pool_approvals_operation",
        type: "unique",
        columns: ["pool_id", "operation_id"],
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true },
    pool_id: { type: "uuid", not_null: true },
    payer_account_id: { type: "uuid", not_null: true },
    operation_id: { type: "uuid", not_null: true },
    amount_usd: {
      type: "string",
      pg_type: "NUMERIC(20,10)",
      not_null: true,
      pg_check: "CHECK (amount_usd > 0 AND amount_usd < 10000000000)",
    },
    starts_at: { type: "timestamp", not_null: true },
    ends_at: { type: "timestamp", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
  },
});

// These sessions exist only on the seed billing authority.  Account-home bays
// prove identity and second factor, but do not own or validate this capability.
Table({
  name: "financial_approval_sessions",
  rules: {
    primary_key: "session_hash",
    durability: "soft",
    pg_indexes: ["account_id", "expire", "revoked_at"],
  },
  fields: {
    session_hash: { type: "string", not_null: true },
    account_id: { type: "uuid", not_null: true },
    approval_origin: { type: "string", not_null: true },
    primary_auth_method: { type: "string", not_null: true },
    primary_verified_at: { type: "timestamp", not_null: true },
    factor_level: { type: "string", not_null: true },
    factor_verified_at: { type: "timestamp" },
    authenticated_for_intent_id: { type: "uuid", not_null: true },
    created_at: { type: "timestamp", not_null: true, pg_default: "now()" },
    expire: { type: "timestamp", not_null: true },
    revoked_at: { type: "timestamp" },
  },
});
