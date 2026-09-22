/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { Table } from "./types";
import type { FieldSpec } from "./types";

const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  not_null: true,
  desc,
});

Table({
  name: "agent_file_grants",
  rules: {
    primary_key: "grant_id",
    pg_constraints: [
      {
        name: "agent_file_grants_agent_id_fkey",
        type: "foreign-key",
        columns: ["agent_id"],
        references: { table: "agent_identities", columns: ["agent_id"] },
      },
      {
        name: "agent_file_grants_mode_check",
        type: "check",
        expression: "mode IN ('read')",
      },
      {
        name: "agent_file_grants_account_agent_target_key",
        type: "unique",
        columns: ["account_id", "agent_id", "target_project_id"],
      },
    ],
    pg_custom_indexes: [
      {
        name: "agent_file_grants_active_agent",
        query: "(agent_id,account_id) WHERE revoked_at IS NULL",
      },
    ],
  },
  fields: {
    grant_id: required("uuid", "File grant capability generation identifier."),
    account_id: required("uuid", "Human principal that selected the grant."),
    agent_id: required("uuid", "Stable source agent identity."),
    source_project_id: required(
      "uuid",
      "Project containing the agent runtime.",
    ),
    target_project_id: required("uuid", "Project whose files may be read."),
    roots: {
      type: "array",
      pg_type: "JSONB",
      not_null: true,
      desc: "Canonical project-home-relative read roots.",
    },
    mode: required("string", "Granted filesystem mode; currently read only."),
    created_at: {
      ...required("timestamp", "Grant creation time."),
      pg_type: "TIMESTAMPTZ",
      pg_default: "now()",
    },
    updated_at: {
      ...required("timestamp", "Last human grant update."),
      pg_type: "TIMESTAMPTZ",
      pg_default: "now()",
    },
    revoked_at: {
      type: "timestamp",
      pg_type: "TIMESTAMPTZ",
      desc: "Human revocation time.",
    },
  },
});
