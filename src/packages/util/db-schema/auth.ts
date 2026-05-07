/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";
import { SCHEMA as schema } from "./index";

Table({
  name: "remember_me",
  fields: {
    hash: {
      type: "string",
      pg_type: "CHAR(127)",
    },
    value: {
      type: "map",
    },
    account_id: {
      type: "uuid",
    },
    expire: {
      type: "timestamp",
    },
  },
  rules: {
    primary_key: "hash",
    durability: "soft", // dropping this would just require a user to login again
    pg_indexes: ["account_id"],
  },
});

Table({
  name: "account_second_factors",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "type", "status", "created"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Second-factor record id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns this second factor.",
    },
    type: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Factor type, e.g. totp.",
    },
    label: {
      type: "string",
      pg_type: "varchar(128)",
      desc: "Short user-facing label for the factor.",
    },
    secret_encrypted: {
      type: "string",
      desc: "Encrypted secret material for the factor.",
    },
    status: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Lifecycle status for this factor.",
    },
    created: {
      type: "timestamp",
      desc: "When this factor row was created.",
    },
    activated_at: {
      type: "timestamp",
      desc: "When this factor became active.",
    },
    disabled_at: {
      type: "timestamp",
      desc: "When this factor was disabled.",
    },
    last_used_at: {
      type: "timestamp",
      desc: "When this factor was last used successfully.",
    },
    metadata: {
      type: "map",
      desc: "Non-secret metadata for diagnostics and future factor types.",
    },
  },
});

Table({
  name: "account_second_factor_recovery_codes",
  rules: {
    primary_key: "id",
    pg_indexes: ["account_id", "factor_id", "used_at", "created"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Recovery-code record id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns this recovery code.",
    },
    factor_id: {
      type: "uuid",
      desc: "Active factor that issued this recovery code.",
    },
    code_hash: {
      type: "string",
      pg_type: "varchar(173)",
      desc: "Hash of the one-time recovery code.",
    },
    used_at: {
      type: "timestamp",
      desc: "When this recovery code was consumed.",
    },
    created: {
      type: "timestamp",
      desc: "When this recovery code was created.",
    },
    metadata: {
      type: "map",
      desc: "Reserved metadata.",
    },
  },
});

Table({
  name: "account_auth_challenges",
  rules: {
    primary_key: "id",
    durability: "soft",
    pg_indexes: ["account_id", "purpose", "expire", "completed_at", "created"],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Auth challenge id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns this challenge.",
    },
    purpose: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Challenge purpose such as sign_in or fresh_auth.",
    },
    password_verified_at: {
      type: "timestamp",
      desc: "When the password was verified for this challenge.",
    },
    factor_verified_at: {
      type: "timestamp",
      desc: "When the second factor was verified.",
    },
    verified_factor_type: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Factor type used to complete the challenge.",
    },
    target_session_hash: {
      type: "string",
      pg_type: "char(127)",
      desc: "Optional target session hash.",
    },
    expire: {
      type: "timestamp",
      desc: "When this challenge expires.",
    },
    attempt_count: {
      type: "integer",
      desc: "How many verification attempts have been recorded.",
    },
    max_attempts: {
      type: "integer",
      desc: "Maximum allowed attempts for this challenge.",
    },
    completed_at: {
      type: "timestamp",
      desc: "When this challenge was completed.",
    },
    created: {
      type: "timestamp",
      desc: "When this challenge was created.",
    },
    metadata: {
      type: "map",
      desc: "Non-secret challenge metadata.",
    },
  },
});

Table({
  name: "account_auth_sessions",
  rules: {
    primary_key: "session_hash",
    durability: "soft",
    pg_indexes: ["account_id", "expire", "updated", "revoked_at"],
  },
  fields: {
    session_hash: {
      type: "string",
      pg_type: "char(127)",
      desc: "Hash of the remember_me session cookie.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns this browser auth session.",
    },
    created: {
      type: "timestamp",
      desc: "When this session metadata row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this session metadata row was last updated.",
    },
    expire: {
      type: "timestamp",
      desc: "When the corresponding remember_me cookie expires.",
    },
    authenticated_at: {
      type: "timestamp",
      desc: "When this browser session last completed sign-in.",
    },
    password_verified_at: {
      type: "timestamp",
      desc: "When password verification was last completed for this session.",
    },
    factor_verified_at: {
      type: "timestamp",
      desc: "When second-factor verification was last completed for this session.",
    },
    fresh_auth_until: {
      type: "timestamp",
      desc: "If set, dangerous actions are allowed until this time.",
    },
    factor_level: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "How this session most recently satisfied second-factor requirements.",
    },
    ip_address: {
      type: "string",
      pg_type: "inet",
      desc: "Client IP address for the session.",
    },
    user_agent: {
      type: "string",
      desc: "Client user agent for diagnostics.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this session was revoked.",
    },
    metadata: {
      type: "map",
      desc: "Reserved session metadata.",
    },
  },
});

Table({
  name: "auth_tokens",
  fields: {
    auth_token: {
      type: "string",
      pg_type: "CHAR(24)",
    },
    account_id: {
      desc: "User who this auth token grants access to become",
      type: "uuid",
      render: { type: "account" },
    },
    expire: {
      type: "timestamp",
      render: { type: "timestamp", editable: false },
    },
    created: {
      desc: "When this auth token was created",
      type: "timestamp",
      render: { type: "timestamp" },
    },
    created_by: {
      desc: "User who created the auth token.",
      type: "uuid",
      render: { type: "account" },
    },
    is_admin: {
      desc: "True if wser who created the auth token did so as an admin.",
      type: "boolean",
    },
  },
  rules: {
    primary_key: "auth_token",
  },
});

Table({
  name: "crm_auth_tokens",
  rules: {
    virtual: "auth_tokens",
    primary_key: "auth_token",
    user_query: {
      get: {
        admin: true, // only admins can do get queries on this table
        fields: {
          account_id: null,
          expire: null,
          created: null,
          created_by: null,
          is_admin: null,
        },
      },
    },
  },
  fields: schema.auth_tokens.fields,
});
