/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CLAUDE_SUBSCRIPTION_KIND } from "../ai/external-credential-profiles";
import { Table } from "./types";

Table({
  name: "external_credentials",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "provider",
      "kind",
      "scope",
      "owner_account_id",
      "project_id",
      "organization_id",
      "revoked",
      "updated",
    ],
    pg_custom_indexes: [
      // Claude subscriptions by reading time, for fresh readings
      // (server/agents/claude-usage-probe.ts orders by this expression).
      {
        name: "external_credentials_claude_reading_at_idx",
        query:
          "((COALESCE(metadata->'claude_usage'->>'observed_at', ''))) " +
          `WHERE kind = '${CLAUDE_SUBSCRIPTION_KIND}' AND revoked IS NULL`,
      },
    ],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Credential record id.",
    },
    provider: {
      type: "string",
      pg_type: "varchar(64)",
      desc: "Credential provider (e.g., openai, anthropic, google).",
    },
    kind: {
      type: "string",
      pg_type: "varchar(96)",
      desc: "Credential kind within provider (e.g., codex-subscription-auth-json, api-key).",
    },
    scope: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Credential scope (e.g., account, project, organization, site).",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Owning account for account-scoped credentials.",
    },
    project_id: {
      type: "uuid",
      desc: "Project id for project-scoped credentials.",
    },
    organization_id: {
      type: "uuid",
      desc: "Organization id for organization-scoped credentials.",
    },
    encrypted_payload: {
      type: "string",
      desc: "Encrypted secret payload.",
    },
    metadata: {
      type: "map",
      desc: "Non-secret metadata used for diagnostics and compatibility checks.",
    },
    created: {
      type: "timestamp",
      desc: "When this credential record was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this credential record was last updated.",
    },
    revoked: {
      type: "timestamp",
      desc: "When this credential record was revoked.",
    },
    last_used: {
      type: "timestamp",
      desc: "When this credential record was last used to serve a request.",
    },
  },
});
