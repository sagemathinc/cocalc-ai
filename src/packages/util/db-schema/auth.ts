/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

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
  name: "account_cli_auth_challenges",
  rules: {
    primary_key: "id",
    durability: "soft",
    pg_indexes: [
      "account_id",
      "kind",
      "status",
      "expire",
      "created",
      "target_session_hash",
    ],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "CLI auth challenge id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that owns this CLI auth challenge.",
    },
    kind: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Challenge kind such as login or elevate.",
    },
    status: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Challenge lifecycle status.",
    },
    poll_token_hash: {
      type: "string",
      pg_type: "char(64)",
      desc: "SHA-256 hash of the CLI poll token.",
    },
    redeem_token_hash: {
      type: "string",
      pg_type: "char(64)",
      desc: "Optional SHA-256 hash of the one-time redeem token.",
    },
    target_session_hash: {
      type: "string",
      pg_type: "char(127)",
      desc: "Optional auth session hash targeted by this challenge.",
    },
    requested_duration: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Requested fresh-auth duration for elevate challenges.",
    },
    approved_at: {
      type: "timestamp",
      desc: "When this challenge was approved in the browser.",
    },
    redeemed_at: {
      type: "timestamp",
      desc: "When this login challenge was redeemed by the CLI.",
    },
    expire: {
      type: "timestamp",
      desc: "When this CLI auth challenge expires.",
    },
    created: {
      type: "timestamp",
      desc: "When this CLI auth challenge was created.",
    },
    metadata: {
      type: "map",
      desc: "Reserved CLI auth challenge metadata.",
    },
  },
});

Table({
  name: "account_impersonation_grants",
  rules: {
    primary_key: "id",
    durability: "soft",
    pg_indexes: [
      "subject_account_id",
      "actor_account_id",
      "expire",
      "consumed_at",
      "revoked_at",
      "created",
    ],
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Opaque one-time impersonation grant id.",
    },
    subject_account_id: {
      type: "uuid",
      desc: "Account being impersonated.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account starting the impersonation.",
    },
    created: {
      type: "timestamp",
      desc: "When this grant was created.",
    },
    expire: {
      type: "timestamp",
      desc: "When this grant expires.",
    },
    consumed_at: {
      type: "timestamp",
      desc: "When this grant was redeemed into a browser session.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this grant was revoked before use.",
    },
    created_on_bay_id: {
      type: "string",
      desc: "Bay that created this grant.",
    },
    subject_home_bay_id: {
      type: "string",
      desc: "Subject account home bay when the grant was created.",
    },
    actor_session_hash: {
      type: "string",
      pg_type: "char(127)",
      desc: "Admin browser session hash that created the grant.",
    },
    actor_authenticated_at: {
      type: "timestamp",
      desc: "Admin session authenticated_at copied into the grant.",
    },
    actor_password_verified_at: {
      type: "timestamp",
      desc: "Admin password verification timestamp copied into the grant.",
    },
    actor_factor_verified_at: {
      type: "timestamp",
      desc: "Admin factor verification timestamp copied into the grant.",
    },
    actor_fresh_auth_until: {
      type: "timestamp",
      desc: "Admin fresh-auth deadline copied into the grant.",
    },
    actor_factor_level: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Admin factor level copied into the grant.",
    },
    reason: {
      type: "string",
      desc: "Optional operator reason for impersonation.",
    },
    metadata: {
      type: "map",
      desc: "Non-secret grant metadata for diagnostics and audit context.",
    },
  },
});

Table({
  name: "account_impersonation_sessions",
  rules: {
    primary_key: "session_hash",
    durability: "soft",
    pg_indexes: [
      "subject_account_id",
      "actor_account_id",
      "grant_id",
      "status",
      "expire",
      "updated",
    ],
  },
  fields: {
    session_hash: {
      type: "string",
      pg_type: "char(127)",
      desc: "Subject browser session hash from remember_me.",
    },
    subject_account_id: {
      type: "uuid",
      desc: "Account currently being impersonated in this browser session.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Admin account acting as the subject.",
    },
    grant_id: {
      type: "uuid",
      desc: "Grant that created this impersonation session.",
    },
    created: {
      type: "timestamp",
      desc: "When this impersonation session row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this impersonation session row was last updated.",
    },
    expire: {
      type: "timestamp",
      desc: "When the subject browser session expires.",
    },
    actor_authenticated_at: {
      type: "timestamp",
      desc: "Admin authenticated_at copied into the impersonation session.",
    },
    actor_password_verified_at: {
      type: "timestamp",
      desc: "Admin password verification timestamp copied into the session.",
    },
    actor_factor_verified_at: {
      type: "timestamp",
      desc: "Admin factor verification timestamp copied into the session.",
    },
    actor_fresh_auth_until: {
      type: "timestamp",
      desc: "Fresh-auth deadline for dangerous actions during impersonation.",
    },
    actor_factor_level: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Most recent admin second-factor level for this impersonation session.",
    },
    status: {
      type: "string",
      pg_type: "varchar(32)",
      desc: "Lifecycle status such as active, ended, or revoked.",
    },
    reason: {
      type: "string",
      desc: "Optional operator reason carried from the grant.",
    },
    metadata: {
      type: "map",
      desc: "Non-secret impersonation session metadata and audit context.",
    },
  },
});
