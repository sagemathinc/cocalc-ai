/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "project_entitlement_overrides",
  rules: {
    primary_key: "project_id",
    pg_indexes: ["enabled", "expires_at", "updated_by", "updated_at"],
    user_query: {
      set: {
        admin: true,
        delete: true,
        fields: {
          project_id: null,
          enabled: null,
          project_defaults: null,
          reason: null,
          source: null,
          metadata: null,
          expires_at: null,
          updated_by: null,
          updated_at: null,
        },
      },
      get: {
        admin: true,
        fields: {
          project_id: null,
          enabled: null,
          project_defaults: null,
          reason: null,
          source: null,
          metadata: null,
          expires_at: null,
          updated_by: null,
          updated_at: null,
        },
      },
    },
  },
  fields: {
    project_id: {
      type: "uuid",
      desc: "Project receiving this entitlement override.",
      render: { type: "project_link" },
    },
    enabled: {
      type: "boolean",
      desc: "Whether this override row is active when it has not expired.",
    },
    project_defaults: {
      type: "map",
      desc: "Project default overrides such as disk_quota, memory, and memory_request.",
    },
    reason: {
      type: "string",
      desc: "Admin-entered or system-entered reason for this override.",
    },
    source: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Source that created the override, e.g. admin or legacy_migration.",
    },
    metadata: {
      type: "map",
      desc: "Structured metadata about this project override.",
    },
    expires_at: {
      type: "timestamp",
      desc: "Optional expiration time for this override.",
    },
    updated_by: {
      type: "uuid",
      desc: "Admin account that last changed this override, if applicable.",
      render: { type: "account" },
    },
    updated_at: {
      type: "timestamp",
      desc: "When this override was last changed.",
    },
  },
});

Table({
  name: "project_entitlement_override_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["project_id", "actor_account_id", "action", "created_at"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          project_id: null,
          action: null,
          old_value: null,
          new_value: null,
          reason: null,
          actor_account_id: null,
          created_at: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique id for this immutable override event.",
    },
    project_id: {
      type: "uuid",
      desc: "Project whose override changed.",
      render: { type: "project_link" },
    },
    action: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Override event action.",
    },
    old_value: {
      type: "map",
      desc: "Previous override value.",
    },
    new_value: {
      type: "map",
      desc: "New override value.",
    },
    reason: {
      type: "string",
      desc: "Admin-entered or system-entered reason for the override change.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account that made this change, if applicable.",
      render: { type: "account" },
    },
    created_at: {
      type: "timestamp",
      desc: "When this immutable override event was written.",
    },
  },
});
