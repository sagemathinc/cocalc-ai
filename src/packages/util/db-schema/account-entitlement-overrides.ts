/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "account_entitlement_overrides",
  rules: {
    primary_key: "account_id",
    pg_indexes: ["enabled", "expires_at", "updated_by", "updated_at"],
    user_query: {
      set: {
        admin: true,
        delete: true,
        fields: {
          account_id: null,
          enabled: null,
          features: null,
          project_defaults: null,
          ai_limits: null,
          usage_limits: null,
          dedicated_hosts: null,
          reason: null,
          expires_at: null,
          updated_by: null,
          updated_at: null,
        },
      },
      get: {
        admin: true,
        fields: {
          account_id: null,
          enabled: null,
          features: null,
          project_defaults: null,
          ai_limits: null,
          usage_limits: null,
          dedicated_hosts: null,
          reason: null,
          expires_at: null,
          updated_by: null,
          updated_at: null,
        },
      },
    },
  },
  fields: {
    account_id: {
      type: "uuid",
      desc: "Account receiving the admin entitlement override.",
      render: { type: "account" },
    },
    enabled: {
      type: "boolean",
      desc: "Whether this override row is active when it has not expired.",
    },
    features: {
      type: "map",
      desc: "Feature entitlement overrides.",
    },
    project_defaults: {
      type: "map",
      desc: "Project default overrides such as disk_quota, memory, and memory_request.",
    },
    ai_limits: {
      type: "map",
      desc: "AI limit overrides such as units_5h and units_7d.",
    },
    usage_limits: {
      type: "map",
      desc: "Membership usage limit overrides.",
    },
    dedicated_hosts: {
      type: "map",
      desc: "Dedicated-host policy overrides.",
    },
    reason: {
      type: "string",
      desc: "Admin-entered reason for this override.",
    },
    expires_at: {
      type: "timestamp",
      desc: "Optional expiration time for this override.",
    },
    updated_by: {
      type: "uuid",
      desc: "Admin account that last changed this override.",
      render: { type: "account" },
    },
    updated_at: {
      type: "timestamp",
      desc: "When this override was last changed.",
    },
  },
});

Table({
  name: "account_entitlement_override_events",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "actor_account_id", "action", "created_at"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          account_id: null,
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
    account_id: {
      type: "uuid",
      desc: "Account whose override changed.",
      render: { type: "account" },
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
      desc: "Admin-entered reason for the override change.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account that made this change.",
      render: { type: "account" },
    },
    created_at: {
      type: "timestamp",
      desc: "When this immutable override event was written.",
    },
  },
});
