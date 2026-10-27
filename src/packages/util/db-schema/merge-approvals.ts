/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

// Merge approvals (util/merge-approval.ts, server/merge-approvals). These live
// on the seed bay only. No user or project query can read or write them: they
// are reached only through the merge approval API. Decisions and relay results
// are append-only and requests can only move between allowed statuses,
// enforced by triggers (database/postgres/schema/merge-approval-integrity.ts).

Table({
  name: "merge_approval_requests",
  rules: {
    primary_key: "id",
    pg_indexes: ["status", "created_at", "expires_at"],
    pg_custom_indexes: [
      {
        name: "merge_approval_requests_repo_pr_idx",
        query: "(repo, pr_number)",
      },
      {
        name: "merge_approval_requests_project_idx",
        query: "((requested_by->>'project_id'), created_at)",
      },
    ],
    pg_constraints: [
      {
        name: "merge_approval_requests_status_check",
        type: "check",
        expression:
          "status IN ('pending','approved','rejected','superseded','withdrawn','expired')",
      },
      {
        name: "merge_approval_requests_head_sha_check",
        type: "check",
        expression: "head_sha ~ '^[0-9a-f]{40}$'",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true, desc: "Request id." },
    repo: {
      type: "string",
      pg_type: "VARCHAR(140)",
      not_null: true,
      desc: "GitHub repository, owner/name, lowercase.",
    },
    pr_number: {
      type: "integer",
      not_null: true,
      desc: "Pull request number.",
    },
    head_sha: {
      type: "string",
      pg_type: "VARCHAR(40)",
      not_null: true,
      desc: "The exact head commit the approval is for.",
    },
    base_ref: {
      type: "string",
      not_null: true,
      desc: "Base branch, as read from GitHub.",
    },
    github_snapshot: {
      type: "map",
      not_null: true,
      desc: "What the hub read from GitHub when the request was made.",
    },
    agent_note: {
      type: "string",
      desc: "Text supplied by the requesting agent; shown labelled as such.",
    },
    requested_by: {
      type: "map",
      not_null: true,
      desc: "Requesting account, project and session, from the authenticated session.",
    },
    chat: {
      type: "map",
      desc: "Where the card is shown: project, path, thread.",
    },
    created_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "now()",
      desc: "When the request was made.",
    },
    expires_at: {
      type: "timestamp",
      not_null: true,
      desc: "After this the request can no longer be decided.",
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(16)",
      not_null: true,
      pg_default: "'pending'",
      desc: "pending, approved, rejected, superseded, withdrawn or expired.",
    },
  },
});

Table({
  name: "merge_approval_decisions",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "decided_at"],
    pg_custom_indexes: [
      {
        // One decision per request.
        name: "merge_approval_decisions_request_unique",
        unique: true,
        query: "(request_id)",
      },
    ],
    pg_constraints: [
      {
        name: "merge_approval_decisions_request_fk",
        type: "foreign-key",
        columns: ["request_id"],
        references: { table: "merge_approval_requests", columns: ["id"] },
        on_delete: "restrict",
      },
      {
        name: "merge_approval_decisions_decision_check",
        type: "check",
        expression: "decision IN ('approve','reject')",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true, desc: "Decision id." },
    request_id: { type: "uuid", not_null: true, desc: "The request decided." },
    account_id: {
      type: "uuid",
      not_null: true,
      desc: "The approver who decided.",
      render: { type: "account" },
    },
    decision: {
      type: "string",
      pg_type: "VARCHAR(16)",
      not_null: true,
      desc: "approve or reject.",
    },
    comment: { type: "string", desc: "The approver's comment, if any." },
    session_hash: {
      type: "string",
      not_null: true,
      desc: "Browser session that decided.",
    },
    factor_level: {
      type: "string",
      not_null: true,
      desc: "Authentication level of that session when deciding.",
    },
    decided_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "now()",
      desc: "When.",
    },
  },
});

Table({
  name: "merge_approval_relays",
  rules: {
    primary_key: "id",
    pg_indexes: ["decision_id", "request_id", "attempted_at"],
    pg_constraints: [
      {
        name: "merge_approval_relays_decision_fk",
        type: "foreign-key",
        columns: ["decision_id"],
        references: { table: "merge_approval_decisions", columns: ["id"] },
        on_delete: "restrict",
      },
    ],
  },
  fields: {
    id: { type: "uuid", not_null: true, desc: "Relay attempt id." },
    decision_id: {
      type: "uuid",
      not_null: true,
      desc: "The approval being relayed.",
    },
    request_id: { type: "uuid", not_null: true, desc: "Its request." },
    attempted_at: {
      type: "timestamp",
      not_null: true,
      pg_default: "now()",
      desc: "When.",
    },
    outcome: {
      type: "string",
      pg_type: "VARCHAR(32)",
      not_null: true,
      desc: "posted, superseded or failed.",
    },
    head_sha_seen: {
      type: "string",
      pg_type: "VARCHAR(40)",
      desc: "The PR head read just before posting.",
    },
    review_id: { type: "string", desc: "GitHub review id, when posted." },
    status_state: {
      type: "string",
      desc: "Commit status state posted, when posted.",
    },
    relay_error: { type: "string", desc: "Error, when failed." },
  },
});
