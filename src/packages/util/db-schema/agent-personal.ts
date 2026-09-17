/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { Table } from "./types";
import type { FieldSpec } from "./types";

const field = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  desc,
  not_null: true,
});
const time = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const created = {
  ...time("Creation time."),
  not_null: true,
  pg_default: "now()",
};
const paused = {
  ...field("boolean", "Restrictive pause independent of expiry."),
  pg_default: "false",
};
const generation = {
  ...field("integer", "Account revocation generation."),
  pg_default: "0",
};

// Account-home authoritative records. Endpoints deliberately have no local FK.
Table({
  name: "agent_personal_controls",
  rules: { primary_key: "account_id" },
  fields: {
    account_id: field("uuid", "Account authority."),
    paused,
    generation,
  },
});
Table({
  name: "agent_personal_names",
  rules: {
    primary_key: ["account_id", "name"],
    pg_custom_indexes: [
      {
        name: "agent_personal_current_endpoint",
        unique: true,
        query: "(account_id,project_id,agent_id) WHERE retired_at IS NULL",
      },
    ],
  },
  fields: {
    account_id: field("uuid", "Naming account."),
    name: field("string", "Normalized name; retained after rename."),
    project_id: field("uuid", "Owning project locator."),
    agent_id: field("uuid", "Immutable identity."),
    metadata: field(
      "map",
      "Safe account-authored metadata and identity path/thread snapshot; no message body.",
    ),
    retired_at: time("Tombstone; never retarget a retired name."),
    created_at: created,
    updated_at: created,
  },
});
Table({
  name: "agent_personal_grants",
  rules: {
    primary_key: "link_id",
    pg_custom_indexes: [
      {
        name: "agent_personal_grant_source",
        query: "(account_id,source_project_id,source_agent_id)",
      },
      {
        name: "agent_personal_approval_direction",
        unique: true,
        query:
          "(account_id,approval_request_id,source_project_id,source_agent_id)",
      },
      {
        name: "agent_personal_grant_group",
        query: "(account_id,direction_group_id)",
      },
    ],
  },
  fields: {
    link_id: field("uuid", "Immutable directional grant."),
    account_id: field(
      "uuid",
      "Approver and execution principal at both endpoints.",
    ),
    source_project_id: field("uuid", "Source project."),
    source_agent_id: field("uuid", "Source identity."),
    target_project_id: field("uuid", "Target project."),
    target_agent_id: field("uuid", "Target identity."),
    direction_group_id: field(
      "uuid",
      "Atomic one-way or two-way connection group.",
    ),
    approval_request_id: field(
      "uuid",
      "Idempotent approval ID; never a send ID.",
    ),
    approval: field(
      "map",
      "Canonical approval parameters for conflict detection.",
    ),
    reason: field("string", "Approval reason."),
    allow_guidance: {
      ...field("boolean", "Explicit steering permission."),
      pg_default: "false",
    },
    generation,
    paused,
    created_at: created,
    expires_at: time("Null means never expires, not immunity to controls."),
    revoked_at: time("Permanent revocation of this grant."),
    last_attempt_at: time(
      "Best-effort last observed attempt; missing means unknown.",
    ),
    last_accepted_at: time("Best-effort acceptance, not completion."),
  },
});
Table({
  name: "agent_personal_requests",
  rules: {
    primary_key: "request_id",
    pg_constraints: [
      {
        name: "agent_personal_request_canonical_fkey",
        type: "foreign-key",
        columns: ["canonical_request_id"],
        references: {
          table: "agent_personal_requests",
          columns: ["request_id"],
        },
      },
    ],
    pg_custom_indexes: [
      { name: "agent_personal_pending", query: "(account_id,created_at DESC)" },
    ],
  },
  fields: {
    request_id: field("uuid", "Request identifier, not a capability."),
    canonical_request_id: {
      type: "uuid",
      desc: "Coalesced submitted ID points to one canonical request on this account home; never independent approval state.",
    },
    account_id: field(
      "uuid",
      "Derived run principal; only this human can resolve.",
    ),
    source_project_id: field("uuid", "Source project."),
    source_agent_id: field("uuid", "Source identity."),
    run_id: field("uuid", "Bound original run; approval revalidates it."),
    generation,
    request: field(
      "map",
      "Exact endpoint/duration/direction/reason, no credential or message.",
    ),
    state: field(
      "string",
      "pending, approved, denied, expired, or invalidated.",
    ),
    direction_group_id: { type: "uuid", desc: "Approved grant group, if any." },
    created_at: created,
    expires_at: {
      ...time("Pending request expires after 15 minutes."),
      not_null: true,
    },
  },
});
