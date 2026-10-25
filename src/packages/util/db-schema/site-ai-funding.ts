/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Site-funded AI: the site pays for AI turns (Codex, Claude) and speech within
budgets. All of these tables are seed-global: admission, settlement and key
management run on the seed bay (other bays reach it over inter-bay calls), so
the concurrency and spending limits hold across the cluster.

These tables predate this file; they were created at runtime by the server.
Their columns, defaults, constraint and index names match what that code
created, so startup schema sync converges existing databases without
rebuilding anything. Server access only: there are no user queries.
*/

import { Table } from "./types";

const TIMESTAMPTZ = "TIMESTAMPTZ";
const BIGINT = "BIGINT";

Table({
  name: "site_ai_funding_periods",
  rules: {
    desc: "One budget period of a site-funded AI pool: its limit and the money reserved for running turns and committed by finished ones.",
    primary_key: ["pool_id", "period_start"],
    pg_constraints: [
      {
        name: "site_ai_funding_periods_limit_microusd_check",
        type: "check",
        expression: "limit_microusd >= 0",
      },
      {
        name: "site_ai_funding_periods_reserved_microusd_check",
        type: "check",
        expression: "reserved_microusd >= 0",
      },
      {
        name: "site_ai_funding_periods_committed_microusd_check",
        type: "check",
        expression: "committed_microusd >= 0",
      },
    ],
  },
  fields: {
    pool_id: {
      type: "string",
      not_null: true,
      desc: "The funding pool, e.g. site-funded-codex-free, -paid or -global.",
    },
    period_start: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "Start of the budget period.",
    },
    period_end: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "End of the budget period (exclusive).",
    },
    limit_microusd: {
      type: "integer",
      pg_type: BIGINT,
      not_null: true,
      desc: "The pool's budget for this period, in millionths of a US dollar.",
    },
    reserved_microusd: {
      type: "integer",
      pg_type: BIGINT,
      pg_default: "0",
      not_null: true,
      desc: "Held for turns still running (released or committed as they finish).",
    },
    committed_microusd: {
      type: "integer",
      pg_type: BIGINT,
      pg_default: "0",
      not_null: true,
      desc: "Spent by finished turns.",
    },
    policy_version: {
      type: "integer",
      not_null: true,
      desc: "Version of the funding policy the period was opened under.",
    },
    created_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When the period was opened.",
    },
    updated_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "Last change to its totals.",
    },
  },
});

Table({
  name: "site_ai_turn_reservations",
  rules: {
    desc: "One admitted site-funded AI turn: what it may spend, what it has spent, and how it ended.",
    primary_key: "reservation_id",
    pg_custom_indexes: [
      {
        name: "site_ai_turn_reservations_account_started_idx",
        query: "(account_id, started_at DESC)",
      },
      {
        name: "site_ai_turn_reservations_active_idx",
        query: "(status, expires_at) WHERE status = 'active'",
      },
      {
        name: "site_ai_turn_reservations_provider_key_idx",
        query:
          "(provider_key_id, started_at) WHERE provider_key_id IS NOT NULL",
      },
    ],
    pg_constraints: [
      {
        name: "site_ai_turn_reservations_funded_turn_id_key",
        type: "unique",
        columns: ["funded_turn_id"],
      },
      {
        name: "site_ai_turn_reservations_idempotency_key_key",
        type: "unique",
        columns: ["idempotency_key"],
      },
      {
        name: "site_ai_turn_reservations_pool_id_period_start_fkey",
        type: "foreign-key",
        columns: ["pool_id", "period_start"],
        references: {
          table: "site_ai_funding_periods",
          columns: ["pool_id", "period_start"],
        },
      },
      {
        name: "site_ai_turn_reservations_reserved_microusd_check",
        type: "check",
        expression: "reserved_microusd >= 0",
      },
      {
        name: "site_ai_turn_reservations_pool_reserved_microusd_check",
        type: "check",
        expression: "pool_reserved_microusd >= 0",
      },
      {
        name: "site_ai_turn_reservations_committed_microusd_check",
        type: "check",
        expression: "committed_microusd >= 0",
      },
      {
        name: "site_ai_turn_reservations_last_request_sequence_check",
        type: "check",
        expression: "last_request_sequence >= 0",
      },
      {
        name: "site_ai_turn_reservations_last_event_cost_microusd_check",
        type: "check",
        expression: "last_event_cost_microusd >= 0",
      },
      {
        name: "site_ai_turn_reservations_status_check",
        type: "check",
        expression:
          "status IN ('active','committed','released','expired','interrupted','failed')",
      },
    ],
  },
  fields: {
    reservation_id: {
      type: "uuid",
      not_null: true,
      desc: "This reservation.",
    },
    funded_turn_id: {
      type: "uuid",
      not_null: true,
      desc: "The turn it funds (unique: one reservation per turn).",
    },
    idempotency_key: {
      type: "string",
      not_null: true,
      desc: "Makes a retried admission return the same reservation.",
    },
    pool_id: {
      type: "string",
      not_null: true,
      desc: "The pool it draws on (with period_start, its funding period).",
    },
    period_start: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "Start of the funding period it draws on.",
    },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "The account whose turn it is.",
    },
    project_id: {
      type: "uuid",
      not_null: true,
      desc: "The project the turn runs in.",
    },
    host_id: {
      type: "uuid",
      not_null: true,
      desc: "The project host running the turn (the only host given its credential).",
    },
    home_bay_id: {
      type: "string",
      desc: "The account's home bay, when known.",
    },
    owning_bay_id: {
      type: "string",
      desc: "The bay that owns the project, when known.",
    },
    membership_tier: {
      type: "string",
      not_null: true,
      desc: "The account's membership tier at admission.",
    },
    policy_version: {
      type: "integer",
      not_null: true,
      desc: "Version of the funding policy it was admitted under.",
    },
    model: {
      type: "string",
      not_null: true,
      desc: "The funded model.",
    },
    reasoning: {
      type: "string",
      not_null: true,
      desc: "The funded reasoning effort.",
    },
    service_tier: {
      type: "string",
      not_null: true,
      desc: "The funded service tier.",
    },
    policy: {
      type: "map",
      not_null: true,
      desc: "The admission policy snapshot: limits the turn must stay within.",
    },
    surface: {
      type: "string",
      desc: "Where the turn started: chat, jupyter, editor or unknown.",
    },
    reserved_microusd: {
      type: "integer",
      pg_type: BIGINT,
      not_null: true,
      desc: "Most this turn may spend, in millionths of a US dollar.",
    },
    pool_reserved_microusd: {
      type: "integer",
      pg_type: BIGINT,
      not_null: true,
      // Upgrading a table from before this column: running turns hold their
      // whole reservation, others nothing (what the old migration did).
      pg_null_backfill:
        "CASE WHEN status = 'active' THEN reserved_microusd ELSE 0 END",
      desc: "What it holds of its pool's period budget while running.",
    },
    committed_microusd: {
      type: "integer",
      pg_type: BIGINT,
      pg_default: "0",
      not_null: true,
      desc: "What it has spent so far.",
    },
    last_request_sequence: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      pg_null_backfill: "0",
      desc: "Sequence number of the last metered provider request, so a repeated usage report counts once.",
    },
    last_event_id: {
      type: "uuid",
      desc: "Id of the last metered usage event.",
    },
    last_event_cost_microusd: {
      type: "integer",
      pg_type: BIGINT,
      pg_default: "0",
      not_null: true,
      pg_null_backfill: "0",
      desc: "Cost of the last metered usage event.",
    },
    last_event_price_version: {
      type: "string",
      desc: "Price table version used for the last usage event.",
    },
    last_event_long_context: {
      type: "boolean",
      desc: "Whether the last usage event was priced as long context.",
    },
    status: {
      type: "string",
      not_null: true,
      desc: "active, committed, released, expired, interrupted or failed.",
    },
    started_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When the turn was admitted.",
    },
    heartbeat_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "The host's last heartbeat for the turn.",
    },
    expires_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "When an unfinished reservation expires (heartbeats extend it).",
    },
    completed_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      desc: "When it left active.",
    },
    outcome: {
      type: "string",
      desc: "Why it ended, when it did not simply commit.",
    },
    provider: {
      type: "string",
      pg_default: "'openai'::text",
      not_null: true,
      pg_null_backfill: "'openai'",
      desc: "openai (Codex) or anthropic (Claude).",
    },
    provider_key_id: {
      type: "uuid",
      desc: "For a Claude turn, the site key (site_ai_provider_keys) that funds it.",
    },
  },
});

Table({
  name: "site_ai_speech_reservations",
  rules: {
    desc: "One site-funded speech request (voice): its reservation and what it cost.",
    primary_key: "request_id",
    pg_custom_indexes: [
      {
        name: "site_ai_speech_reservations_active_idx",
        query: "(status, expires_at) WHERE status = 'active'",
      },
    ],
    pg_constraints: [
      {
        name: "site_ai_speech_reservations_reserved_microusd_check",
        type: "check",
        expression: "reserved_microusd > 0",
      },
      {
        name: "site_ai_speech_reservations_committed_microusd_check",
        type: "check",
        expression: "committed_microusd >= 0",
      },
      {
        name: "site_ai_speech_reservations_status_check",
        type: "check",
        expression: "status IN ('active', 'committed', 'released', 'expired')",
      },
    ],
  },
  fields: {
    request_id: {
      type: "uuid",
      not_null: true,
      desc: "The speech request.",
    },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "The account it is for.",
    },
    period_start: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "The budget period it counts in.",
    },
    reserved_microusd: {
      type: "integer",
      pg_type: BIGINT,
      not_null: true,
      desc: "Most it may cost, in millionths of a US dollar.",
    },
    committed_microusd: {
      type: "integer",
      pg_type: BIGINT,
      pg_default: "0",
      not_null: true,
      desc: "What it cost.",
    },
    status: {
      type: "string",
      not_null: true,
      desc: "active, committed, released or expired.",
    },
    created_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When it was reserved.",
    },
    expires_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      not_null: true,
      desc: "When an unfinished reservation expires.",
    },
    completed_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      desc: "When it left active.",
    },
  },
});

Table({
  name: "site_ai_account_holds",
  rules: {
    desc: "Accounts an admin has stopped from using site-funded AI, and why.",
    primary_key: "account_id",
  },
  fields: {
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "The account on hold.",
    },
    reason: {
      type: "string",
      not_null: true,
      desc: "Why, shown to admins and in the refusal.",
    },
    created_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When the hold was placed.",
    },
    created_by: {
      type: "uuid",
      desc: "The admin who placed it.",
    },
    expires_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      desc: "When the hold ends; none means until removed.",
    },
  },
});

Table({
  name: "site_ai_provider_keys",
  rules: {
    desc: "The site's provider API keys for site-funded Claude, in order, each with a monthly spend limit. A turn is funded by the first key with room left.",
    primary_key: "key_id",
    pg_constraints: [
      {
        name: "site_ai_provider_keys_monthly_limit_microusd_check",
        type: "check",
        expression: "monthly_limit_microusd >= 0",
      },
      {
        name: "site_ai_provider_keys_reset_day_check",
        type: "check",
        expression: "reset_day BETWEEN 1 AND 28",
      },
      {
        name: "site_ai_provider_keys_reset_hour_check",
        type: "check",
        expression: "reset_hour BETWEEN 0 AND 23",
      },
    ],
  },
  fields: {
    key_id: {
      type: "uuid",
      not_null: true,
      desc: "This key.",
    },
    provider: {
      type: "string",
      not_null: true,
      desc: "The provider, e.g. anthropic.",
    },
    label: {
      type: "string",
      not_null: true,
      desc: "The admin's name for the key.",
    },
    encrypted_key: {
      type: "string",
      not_null: true,
      desc: "The API key, encrypted with the site's secret-storage key. It leaves the seed bay only for the host running a turn the key funds.",
    },
    key_last4: {
      type: "string",
      not_null: true,
      desc: "The key's last four characters, to tell keys apart.",
    },
    monthly_limit_microusd: {
      type: "integer",
      pg_type: BIGINT,
      not_null: true,
      desc: "Most the key may fund per month, in millionths of a US dollar. Its spend is read from the turns it funded.",
    },
    reset_day: {
      type: "integer",
      not_null: true,
      desc: "Day of the month (1 to 28) its monthly spend starts again.",
    },
    reset_hour: {
      type: "integer",
      not_null: true,
      desc: "Hour (UTC, 0 to 23) of that day.",
    },
    position: {
      type: "integer",
      not_null: true,
      desc: "Order in which keys are tried.",
    },
    enabled: {
      type: "boolean",
      pg_default: "true",
      not_null: true,
      desc: "Disabled keys fund nothing.",
    },
    created_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When the key was added.",
    },
    updated_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "Last change to the key.",
    },
  },
});

Table({
  name: "site_ai_admission_attempts",
  rules: {
    desc: "One row per site-funded admission attempt and how it ended, for the admin AI pool funnel (kept 90 days).",
    primary_key: "funded_turn_id",
    pg_custom_indexes: [
      {
        name: "site_ai_admission_attempts_attempted_idx",
        query: "(attempted_at)",
      },
    ],
  },
  fields: {
    funded_turn_id: {
      type: "uuid",
      not_null: true,
      desc: "The turn that asked (a retry updates its row).",
    },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "The account that asked.",
    },
    provider: {
      type: "string",
      not_null: true,
      desc: "openai (Codex) or anthropic (Claude).",
    },
    outcome: {
      type: "string",
      not_null: true,
      desc: "allowed, a denial code, a finer early refusal, or error.",
    },
    membership_tier: {
      type: "string",
      desc: "The account's membership tier, when known.",
    },
    surface: {
      type: "string",
      desc: "Where the turn started: chat, jupyter, editor or unknown.",
    },
    attempted_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When it first asked.",
    },
    decided_at: {
      type: "timestamp",
      pg_type: TIMESTAMPTZ,
      pg_default: "now()",
      not_null: true,
      desc: "When the latest decision was made.",
    },
  },
});
