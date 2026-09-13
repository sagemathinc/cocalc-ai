/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "billing_authority_commands",
  rules: {
    primary_key: "command_id",
    pg_indexes: [
      "status",
      "request_hash",
      "lane",
      "account_id",
      "actor_account_id",
      "expires_at",
      "created_at",
      "finished_at",
    ],
    pg_constraints: [
      {
        name: "billing_authority_commands_lane_check",
        type: "check",
        expression: "lane IN ('critical','interactive','maintenance')",
      },
      {
        name: "billing_authority_commands_status_check",
        type: "check",
        expression:
          "status IN ('queued','running','succeeded','failed','canceled','expired','uncertain')",
      },
    ],
  },
  fields: {
    command_id: {
      type: "uuid",
      desc: "Stable idempotency and outcome identity for this authority command.",
    },
    request_hash: {
      type: "string",
      pg_type: "varchar(64)",
      not_null: true,
      desc: "SHA-256 of the canonical command envelope; conflicting reuse fails closed.",
    },
    operation: {
      type: "string",
      pg_type: "varchar(256)",
      not_null: true,
      desc: "Bounded non-secret operation name used for audit and scheduling.",
    },
    lane: {
      type: "string",
      pg_type: "varchar(32)",
      not_null: true,
      desc: "Critical, interactive, or maintenance scheduling lane.",
    },
    account_id: {
      type: "uuid",
      desc: "Account fenced at command start, when the command is account-bound.",
    },
    account_ids: {
      type: "array",
      pg_type: "UUID[]",
      pg_default: "'{}'::uuid[]",
      not_null: true,
      desc: "All target and actor accounts whose fences govern this command.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Authenticated actor account, when the command acts across accounts.",
    },
    command: {
      type: "map",
      not_null: true,
      desc: "Validated internal authority command envelope.",
    },
    status: {
      type: "string",
      pg_type: "varchar(32)",
      pg_default: "'queued'::character varying",
      not_null: true,
      desc: "Durable command lifecycle state.",
    },
    expires_at: {
      type: "timestamp",
      not_null: true,
      desc: "Latest time at which a queued command may start.",
    },
    attempt_count: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      desc: "Number of execution claims; commands are never automatically replayed.",
    },
    authority_generation: {
      type: "integer",
      desc: "Monotonic lease generation that claimed this command.",
    },
    authority_instance_id: {
      type: "uuid",
      desc: "Unique authority process instance that claimed this command.",
    },
    result: {
      type: "map",
      desc: "JSON-encoded successful result.",
    },
    error: {
      type: "map",
      desc: "Bounded structured terminal error.",
    },
    created_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "Submission time.",
    },
    updated_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "Last lifecycle transition time.",
    },
    started_at: {
      type: "timestamp",
      desc: "Execution start time.",
    },
    finished_at: {
      type: "timestamp",
      desc: "Terminal completion time.",
    },
  },
});

Table({
  name: "billing_authority_lease",
  rules: { primary_key: "name" },
  fields: {
    name: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Singleton lease name.",
    },
    holder_id: {
      type: "uuid",
      desc: "Unique process instance holding the current lease.",
    },
    generation: {
      type: "integer",
      pg_default: "0",
      not_null: true,
      desc: "Monotonic fencing generation incremented on each takeover.",
    },
    lease_until: {
      type: "timestamp",
      desc: "Database-clock expiry of the current lease.",
    },
    enabled: {
      type: "boolean",
      pg_default: "TRUE",
      not_null: true,
      desc: "False while operators have globally drained the authority.",
    },
    draining: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Whether the current holder has stopped claiming new commands.",
    },
    serving: {
      type: "boolean",
      pg_default: "FALSE",
      not_null: true,
      desc: "Set only after the elected process has installed live local ownership.",
    },
    handoff_exclude_holder_id: {
      type: "uuid",
      desc: "Instance prohibited from reacquiring during an explicit handoff.",
    },
    updated_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "Last acquire, renewal, or lifecycle transition.",
    },
  },
});

Table({
  name: "billing_authority_account_fences",
  rules: {
    primary_key: "account_id",
    pg_indexes: ["frozen", "updated_at"],
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account whose financial commands are fenced.",
    },
    frozen: {
      type: "boolean",
      pg_default: "TRUE",
      not_null: true,
      desc: "True when ordinary financial commands must fail closed.",
    },
    reason: {
      type: "string",
      desc: "Bounded operator or lifecycle reason.",
    },
    causes: {
      type: "map",
      pg_default: "'{}'::jsonb",
      not_null: true,
      desc: "Independent active fence causes and their audit metadata.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Operator who changed the fence, when applicable.",
    },
    generation: {
      type: "integer",
      pg_default: "1",
      not_null: true,
      desc: "Monotonic account-fence revision.",
    },
    created_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "First fence creation time.",
    },
    updated_at: {
      type: "timestamp",
      pg_default: "now()",
      not_null: true,
      desc: "Most recent fence transition time.",
    },
  },
});
