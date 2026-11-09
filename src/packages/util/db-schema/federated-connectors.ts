/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Federated CLI connectors (util/ai/federated-connectors.ts): the account's
// connections to a cloud's workload identity federation, the grants that map
// to one service account each, the site's allowlist of what may be minted at
// all, and the append-only mint log; which grant each agent uses, the
// per-turn leases, project owners' shared-project approvals, and the
// append-only audit of those changes. Resource names only: no keys or tokens
// are stored, and none of these tables has a user or project query.

import { Table } from "./types";
import type { FieldSpec } from "./types";

const required = (type: FieldSpec["type"], desc: string): FieldSpec => ({
  type,
  not_null: true,
  desc,
});
const timestamp = (desc: string): FieldSpec => ({
  type: "timestamp",
  pg_type: "TIMESTAMPTZ",
  desc,
});
const created = (desc: string): FieldSpec => ({
  ...timestamp(desc),
  not_null: true,
  pg_default: "now()",
});
const text = (desc: string): FieldSpec => ({ type: "string", desc });

const STATE_CHECK = (table: string) => ({
  name: `${table}_state_check`,
  type: "check" as const,
  expression: "state IN ('pending','enabled','disabled')",
});

Table({
  name: "federated_connector_connections",
  rules: {
    primary_key: "connection_id",
    pg_constraints: [
      STATE_CHECK("federated_connector_connections"),
      {
        name: "federated_connector_connections_provider_check",
        type: "check",
        expression: "provider IN ('gcp')",
      },
      {
        name: "federated_connector_connections_use_case_check",
        type: "check",
        expression: "use_case IN ('ops','compute')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_connections_account_idx",
        query: "(account_id)",
      },
    ],
  },
  fields: {
    connection_id: required("uuid", "Stable connection ID."),
    account_id: required("uuid", "Human who owns this connection."),
    provider: required("string", "Cloud provider; only gcp for now."),
    use_case: required(
      "string",
      "ops (operating this site) or compute (the user's own cloud).",
    ),
    state: {
      type: "string",
      not_null: true,
      pg_default: "'pending'",
      desc: "pending until the setup tests pass, then enabled or disabled.",
    },
    pool_project_number: text(
      "Number of the cloud project holding the identity pool.",
    ),
    pool_id: text("Workload identity pool id."),
    provider_id: text("Workload identity provider id (one per connection)."),
    setup_results: {
      type: "map",
      pg_type: "JSONB",
      desc: "Outcome of each setup rejection test; no credentials.",
    },
    enabled_at: timestamp("When the setup tests passed."),
    created_at: created("Connection creation time."),
    updated_at: created("Last connection update."),
  },
});

Table({
  name: "federated_connector_grants",
  rules: {
    primary_key: "grant_id",
    pg_constraints: [
      STATE_CHECK("federated_connector_grants"),
      {
        name: "federated_connector_grants_revision_check",
        type: "check",
        expression: "revision >= 1",
      },
      {
        // The SA's immutable unique id, a decimal string (never a number):
        // required before a grant can be enabled, and what every issued
        // token is checked against (G3b).
        name: "federated_connector_grants_unique_id_check",
        type: "check",
        expression:
          "(service_account_unique_id IS NULL OR service_account_unique_id ~ '^[1-9][0-9]{5,31}$') AND (state <> 'enabled' OR service_account_unique_id IS NOT NULL)",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_grants_connection_idx",
        query: "(connection_id)",
      },
      {
        name: "federated_connector_grants_account_idx",
        query: "(account_id)",
      },
    ],
  },
  fields: {
    grant_id: required(
      "uuid",
      "Immutable grant ID; the cloud side trusts exactly this id.",
    ),
    connection_id: required("uuid", "Connection this grant belongs to."),
    account_id: required("uuid", "Human who owns this grant."),
    revision: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      desc: "Increments on any change of service account, profile or target; leases of an older revision cannot renew.",
    },
    service_account: required(
      "string",
      "Service account resource name (shown to admins only).",
    ),
    service_account_unique_id: text(
      "The service account's immutable unique id (decimal string), from the setup record; required to enable the grant.",
    ),
    sa_label: required(
      "string",
      "Display label for the service account, shown to agents.",
    ),
    target_project: required("string", "Default cloud project id."),
    permission_profile: required(
      "string",
      "Permission profile id, e.g. read-only.",
    ),
    state: {
      type: "string",
      not_null: true,
      pg_default: "'pending'",
      desc: "pending until the setup tests pass, then enabled or disabled.",
    },
    created_at: created("Grant creation time."),
    updated_at: created("Last grant update."),
  },
});

Table({
  name: "federated_connector_allowlist",
  rules: {
    primary_key: "entry_id",
    pg_custom_indexes: [
      {
        name: "federated_connector_allowlist_entry_key",
        unique: true,
        query: "(provider,service_account,permission_profile,target_project)",
      },
    ],
  },
  fields: {
    entry_id: required("uuid", "Allowlist entry ID."),
    provider: required("string", "Cloud provider; only gcp for now."),
    service_account: required(
      "string",
      "Service account a grant may be minted for.",
    ),
    permission_profile: required("string", "Permission profile id."),
    target_project: required("string", "Cloud project id."),
    created_by: required("uuid", "Admin who added the entry."),
    created_at: created("Entry creation time."),
  },
});

Table({
  name: "federated_connector_mint_log",
  rules: {
    primary_key: "mint_id",
    pg_constraints: [
      {
        name: "federated_connector_mint_log_outcome_check",
        type: "check",
        expression: "outcome IN ('issued','denied','error')",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_mint_log_time_idx",
        query: "(time)",
      },
      {
        name: "federated_connector_mint_log_grant_idx",
        query: "(grant_id,time)",
      },
    ],
  },
  fields: {
    mint_id: required("uuid", "Mint attempt ID."),
    time: created("When the attempt was recorded."),
    outcome: required("string", "issued, denied or error."),
    reason: text("Short fixed reason code for a denial or error."),
    site_id: text("Site id claim."),
    account_id: { type: "uuid", desc: "Account the token was for." },
    agent_id: { type: "uuid", desc: "Agent the token was for." },
    project_id: { type: "uuid", desc: "Project of the turn or run." },
    host_id: { type: "uuid", desc: "Host running the turn or run." },
    run_id: { type: "uuid", desc: "Agent run." },
    connection_id: { type: "uuid", desc: "Connection." },
    grant_id: { type: "uuid", desc: "Grant." },
    grant_revision: { type: "integer", desc: "Grant revision minted for." },
    lease_id: { type: "uuid", desc: "Lease id (the assertion's subject)." },
    jti: { type: "uuid", desc: "Assertion id, for correlation only." },
    key_version: text("Signing key version used."),
    service_account: text("Service account the token is for."),
    issued_at: timestamp("When the access token was issued."),
    expires_at: timestamp("When the access token expires."),
  },
});

// Which grant an agent uses in a source project (at most one per agent and
// project). Saved only with fresh auth; every change bumps revision and is
// recorded in federated_connector_assignment_audit.
Table({
  name: "federated_connector_agent_grants",
  rules: {
    primary_key: "assignment_id",
    pg_constraints: [
      {
        name: "federated_connector_agent_grants_revision_check",
        type: "check",
        expression: "revision >= 1",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_agent_grants_agent_project_key",
        unique: true,
        query: "(account_id,agent_id,source_project_id)",
      },
      {
        name: "federated_connector_agent_grants_grant_idx",
        query: "(grant_id)",
      },
    ],
  },
  fields: {
    assignment_id: required("uuid", "Assignment ID."),
    account_id: required("uuid", "Human who owns the grant and the agent."),
    agent_id: required("uuid", "Agent allowed to use the grant."),
    source_project_id: required("uuid", "Project the agent runs in."),
    grant_id: required("uuid", "Grant the agent uses."),
    enabled: {
      type: "boolean",
      not_null: true,
      pg_default: "true",
      desc: "A disabled assignment issues nothing and ends open leases.",
    },
    revision: {
      type: "integer",
      not_null: true,
      pg_default: "1",
      desc: "Increments on every change; a lease bound to an older revision ends.",
    },
    created_at: created("Assignment creation time."),
    updated_at: created("Last assignment change."),
  },
});

// One durable record per verified agent turn. Never reopened and never
// created twice for the same turn: an ended row is the turn's revocation
// tombstone until it is purged, 13 months after it ended. Database triggers
// (database/postgres/schema/federated-connector-guards.ts) keep the binding
// immutable and set ended_at exactly once.
Table({
  name: "federated_connector_turn_leases",
  rules: {
    primary_key: "lease_id",
    pg_constraints: [
      {
        name: "federated_connector_turn_leases_end_check",
        type: "check",
        expression:
          "(ended_at IS NULL AND end_reason IS NULL) OR (ended_at IS NOT NULL AND end_reason IN ('deny','revoke','revision','expired'))",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_turn_leases_turn_key",
        unique: true,
        query: "(account_id,agent_id,source_project_id,run_id,turn_key)",
      },
      {
        name: "federated_connector_turn_leases_open_idx",
        query: "(created_at) WHERE ended_at IS NULL",
      },
      {
        name: "federated_connector_turn_leases_ended_idx",
        query: "(ended_at)",
      },
      {
        name: "federated_connector_turn_leases_assignment_idx",
        query: "(assignment_id)",
      },
    ],
  },
  fields: {
    lease_id: required("uuid", "Lease ID, generated by the hub."),
    account_id: required("uuid", "Account the lease is for."),
    agent_id: required("uuid", "Agent of the turn."),
    source_project_id: required("uuid", "Project of the turn."),
    run_id: required("uuid", "Agent run."),
    turn_key: required(
      "string",
      "Hex sha256 of the canonical JSON of account, agent, project, run and turn reference.",
    ),
    turn_ref: {
      type: "map",
      pg_type: "JSONB",
      not_null: true,
      desc: "The verified turn reference (chat path, message date and ids), so the turn can be checked again before every mint.",
    },
    host_id: required(
      "uuid",
      "Host that began the turn, from its authenticated principal.",
    ),
    assignment_id: required("uuid", "Assignment the lease is bound to."),
    assignment_revision: required("integer", "Assignment revision bound."),
    grant_id: required("uuid", "Grant the lease is bound to."),
    grant_revision: required("integer", "Grant revision bound."),
    approval_id: {
      type: "uuid",
      desc: "Shared-project approval the lease relied on; null for a single-user project.",
    },
    created_at: created("Lease creation time (database clock)."),
    ended_at: timestamp("When the lease ended (database clock, set once)."),
    end_reason: text("deny, revoke, revision or expired."),
  },
});

// A project owner's approval for one account's federated credentials to be
// used in a project that has other members. Kept on the project's owning
// bay; it counts only while its approver is still an owner of the project.
Table({
  name: "federated_connector_shared_project_approvals",
  rules: {
    primary_key: "approval_id",
    pg_constraints: [
      {
        name: "federated_connector_shared_project_approvals_revoke_check",
        type: "check",
        expression:
          "(revoked_at IS NULL AND revoked_by IS NULL AND revoke_reason IS NULL) OR (revoked_at IS NOT NULL AND ((revoke_reason IN ('owner','self') AND revoked_by IS NOT NULL) OR (revoke_reason IN ('rehome','approver-demoted','approved-account-left') AND revoked_by IS NULL)))",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_shared_project_approvals_active_key",
        unique: true,
        query: "(project_id,account_id) WHERE revoked_at IS NULL",
      },
      {
        name: "federated_connector_shared_project_approvals_revoked_idx",
        query: "(revoked_at)",
      },
    ],
  },
  fields: {
    approval_id: required("uuid", "Approval ID."),
    project_id: required("uuid", "Shared project."),
    account_id: required(
      "uuid",
      "Account whose federated credentials may be used in the project.",
    ),
    approver_account_id: required("uuid", "Project owner who approved."),
    created_at: created("Approval time."),
    revoked_at: timestamp("When the approval was revoked (set once)."),
    revoked_by: {
      type: "uuid",
      desc: "Account that revoked the approval; null when the system ended it.",
    },
    revoke_reason: text(
      "owner (an owner revoked it), self (the approved account withdrew it), rehome (the project left this bay), approver-demoted (its approver stopped being an owner) or approved-account-left (the approved account stopped being a full collaborator).",
    ),
  },
});

// Append-only record of every assignment, shared-project approval, site
// gate, broker signer and issuer key pin change, with the actor and fresh-auth facts. Rows stay on the bay
// where they were written (an account or project rehome doesn't move them),
// so an access review must read this table on every bay.
Table({
  name: "federated_connector_assignment_audit",
  rules: {
    primary_key: "id",
    pg_constraints: [
      {
        name: "federated_connector_assignment_audit_action_check",
        type: "check",
        expression:
          "action IN ('assign','change','disable','enable','remove','shared-approve','shared-revoke','site-gate-change','broker-signer-change','issuer-pin-change')",
      },
      {
        // Only the system's own approval revocations have no actor.
        name: "federated_connector_assignment_audit_actor_check",
        type: "check",
        expression:
          "actor_account_id IS NOT NULL OR (action = 'shared-revoke' AND after->>'reason' IN ('rehome','approver-demoted','approved-account-left'))",
      },
    ],
    pg_custom_indexes: [
      {
        name: "federated_connector_assignment_audit_time_idx",
        query: "(time)",
      },
      {
        name: "federated_connector_assignment_audit_account_idx",
        query: "(account_id,time)",
      },
    ],
  },
  fields: {
    id: required("uuid", "Audit row ID."),
    time: created("When the change was recorded (database clock)."),
    action: required("string", "What changed."),
    actor_account_id: {
      type: "uuid",
      desc: "Account that made the change; null only when the system ended an approval (rehome, approver demoted).",
    },
    session_hash: text(
      "Keyed hash of the actor's session id; never of a token or cookie.",
    ),
    fresh_auth_at: timestamp("When the actor last completed fresh auth."),
    account_id: { type: "uuid", desc: "Account whose access changed." },
    agent_id: { type: "uuid", desc: "Agent of the assignment." },
    source_project_id: { type: "uuid", desc: "Project of the change." },
    assignment_id: { type: "uuid", desc: "Assignment changed." },
    approval_id: { type: "uuid", desc: "Shared-project approval changed." },
    before: {
      type: "map",
      pg_type: "JSONB",
      desc: "State before the change (ids, revisions, flags; no credentials).",
    },
    after: {
      type: "map",
      pg_type: "JSONB",
      desc: "State after the change.",
    },
  },
});
