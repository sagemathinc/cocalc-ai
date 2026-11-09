/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Federated CLI connectors (util/ai/federated-connectors.ts): the account's
// connections to a cloud's workload identity federation, the grants that map
// to one service account each, the site's allowlist of what may be minted at
// all, and the append-only mint log. Resource names only: no keys or tokens
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
