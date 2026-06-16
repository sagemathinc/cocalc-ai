/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "site_licenses",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "bay_id",
      "owner_account_id",
      "organization_name",
      "starts_at",
      "expires_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          name: null,
          organization_name: null,
          owner_account_id: null,
          allowed_domains: null,
          custom_terms_url: null,
          custom_policy_url: null,
          terms_version_label: null,
          renewal_policy: null,
          overage_policy: null,
          starts_at: null,
          expires_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          name: null,
          organization_name: null,
          bay_id: null,
          owner_account_id: null,
          allowed_domains: null,
          custom_terms_url: null,
          custom_policy_url: null,
          terms_version_label: null,
          renewal_policy: null,
          overage_policy: null,
          starts_at: null,
          expires_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique site-license id.",
    },
    name: {
      type: "string",
      desc: "Short site-license name.",
    },
    organization_name: {
      type: "string",
      desc: "Licensee organization name.",
    },
    bay_id: {
      type: "string",
      desc: "Seed control-plane bay that owns this site license.",
    },
    owner_account_id: {
      type: "uuid",
      desc: "Canonical responsible account for billing and future self-service ownership. This is not an operational manager role.",
      render: { type: "account" },
    },
    allowed_domains: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Institutional email domains covered by this license.",
    },
    custom_terms_url: {
      type: "string",
      desc: "Optional negotiated terms URL shown before claim/request.",
    },
    custom_policy_url: {
      type: "string",
      desc: "Optional institution policy URL shown before claim/request.",
    },
    terms_version_label: {
      type: "string",
      desc: "Optional label for custom terms/policy acceptance records.",
    },
    renewal_policy: {
      type: "string",
      desc: "Contract renewal policy label.",
    },
    overage_policy: {
      type: "string",
      desc: "Seat overage policy label.",
    },
    starts_at: {
      type: "timestamp",
      desc: "When this site license becomes active.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this site license expires.",
    },
    metadata: {
      type: "map",
      desc: "Optional site-license metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "site_license_managers",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "site_license_id",
      "account_id",
      "role",
      "created_by_account_id",
      "revoked_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          site_license_id: null,
          account_id: null,
          role: null,
          created_by_account_id: null,
          revoked_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          site_license_id: null,
          account_id: null,
          role: null,
          created_by_account_id: null,
          revoked_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique site-license manager row id.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Managed site license.",
    },
    account_id: {
      type: "uuid",
      desc: "Manager account.",
      render: { type: "account" },
    },
    role: {
      type: "string",
      desc: "Delegated site-license role: manager or viewer. The canonical owner is site_licenses.owner_account_id.",
    },
    created_by_account_id: {
      type: "uuid",
      desc: "Account that added this manager.",
      render: { type: "account" },
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this manager role was revoked.",
    },
    metadata: {
      type: "map",
      desc: "Optional manager metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "site_license_pool_requests",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "site_license_id",
      "package_id",
      "account_id",
      "canonical_identity",
      "state",
      "reviewer_account_id",
      "requested_at",
      "reviewed_at",
      "expires_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          site_license_id: null,
          package_id: null,
          account_id: null,
          matched_email_address: null,
          canonical_identity: null,
          requested_membership_class: null,
          state: null,
          requester_note: null,
          reviewer_account_id: null,
          review_note: null,
          requested_at: null,
          reviewed_at: null,
          expires_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          site_license_id: null,
          package_id: null,
          account_id: null,
          matched_email_address: null,
          canonical_identity: null,
          requested_membership_class: null,
          state: null,
          requester_note: null,
          reviewer_account_id: null,
          review_note: null,
          requested_at: null,
          reviewed_at: null,
          expires_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique site-license pool request id.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Site license containing the requested pool.",
    },
    package_id: {
      type: "uuid",
      desc: "Membership package backing the requested pool.",
    },
    account_id: {
      type: "uuid",
      desc: "Requester account.",
      render: { type: "account" },
    },
    matched_email_address: {
      type: "string",
      desc: "Verified institutional email used for eligibility.",
    },
    canonical_identity: {
      type: "string",
      pg_type: "VARCHAR(320)",
      desc: "Canonical institutional identity for duplicate request prevention.",
    },
    requested_membership_class: {
      type: "string",
      desc: "Membership tier requested.",
    },
    state: {
      type: "string",
      desc: "Request state: pending, approved, rejected, canceled, or expired.",
    },
    requester_note: {
      type: "string",
      desc: "Requester-provided role/use note.",
    },
    reviewer_account_id: {
      type: "uuid",
      desc: "Manager account that reviewed this request.",
      render: { type: "account" },
    },
    review_note: {
      type: "string",
      desc: "Manager review note.",
    },
    requested_at: {
      type: "timestamp",
      desc: "Request creation time.",
    },
    reviewed_at: {
      type: "timestamp",
      desc: "Review time.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this pending request expires.",
    },
    metadata: {
      type: "map",
      desc: "Optional request metadata, including custom terms acceptance.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "site_license_audit_log",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "site_license_id",
      "action",
      "actor_account_id",
      "target_account_id",
      "package_id",
      "request_id",
      "created",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          site_license_id: null,
          action: null,
          actor_account_id: null,
          target_account_id: null,
          package_id: null,
          request_id: null,
          metadata: null,
          created: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          site_license_id: null,
          action: null,
          actor_account_id: null,
          target_account_id: null,
          package_id: null,
          request_id: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique site-license audit event id.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Site license this audit event belongs to.",
    },
    action: {
      type: "string",
      desc: "Site-license audit action.",
    },
    actor_account_id: {
      type: "uuid",
      desc: "Account that initiated the action, if any.",
      render: { type: "account" },
    },
    target_account_id: {
      type: "uuid",
      desc: "Account affected by the action, if any.",
      render: { type: "account" },
    },
    package_id: {
      type: "uuid",
      desc: "Membership package affected by the action, if any.",
    },
    request_id: {
      type: "uuid",
      desc: "Site-license pool request affected by the action, if any.",
    },
    metadata: {
      type: "map",
      desc: "Structured audit event metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
  },
});

Table({
  name: "site_license_external_claim_pools",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "site_license_id",
      "package_id",
      "issuer",
      "slug",
      "disabled_at",
      "expires_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          slug: null,
          site_license_id: null,
          package_id: null,
          name: null,
          issuer: null,
          audience: null,
          default_membership_class: null,
          allow_membership_class_override: null,
          default_membership_duration_days: null,
          default_membership_expires_at: null,
          allow_membership_expires_at_override: null,
          min_membership_duration_days: null,
          max_membership_duration_days: null,
          max_membership_expires_at: null,
          default_rootfs_id: null,
          max_claims: null,
          max_claims_per_account: null,
          starts_at: null,
          expires_at: null,
          disabled_at: null,
          metadata: null,
          created_by_account_id: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          slug: null,
          site_license_id: null,
          package_id: null,
          name: null,
          issuer: null,
          audience: null,
          default_membership_class: null,
          allow_membership_class_override: null,
          default_membership_duration_days: null,
          default_membership_expires_at: null,
          allow_membership_expires_at_override: null,
          min_membership_duration_days: null,
          max_membership_duration_days: null,
          max_membership_expires_at: null,
          default_rootfs_id: null,
          max_claims: null,
          max_claims_per_account: null,
          starts_at: null,
          expires_at: null,
          disabled_at: null,
          metadata: null,
          created_by_account_id: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique external claim pool id.",
    },
    slug: {
      type: "string",
      desc: "Optional publisher-friendly pool slug unique within site license and issuer.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Site license containing this external claim pool.",
    },
    package_id: {
      type: "uuid",
      desc: "Membership package backing this external claim pool.",
    },
    name: {
      type: "string",
      desc: "Operator-facing pool name.",
    },
    issuer: {
      type: "string",
      desc: "External token issuer id.",
    },
    audience: {
      type: "string",
      desc: "Required token audience.",
    },
    default_membership_class: {
      type: "string",
      desc: "Default membership class granted by claims in this pool.",
    },
    allow_membership_class_override: {
      type: "boolean",
      desc: "Whether tokens may override the pool membership class.",
    },
    default_membership_duration_days: {
      type: "number",
      desc: "Default grant duration in days when no absolute expiration is set.",
    },
    default_membership_expires_at: {
      type: "timestamp",
      desc: "Default absolute grant expiration.",
    },
    allow_membership_expires_at_override: {
      type: "boolean",
      desc: "Whether tokens may override the membership expiration.",
    },
    min_membership_duration_days: {
      type: "number",
      desc: "Minimum accepted token-provided grant duration in days.",
    },
    max_membership_duration_days: {
      type: "number",
      desc: "Maximum accepted token-provided grant duration in days.",
    },
    max_membership_expires_at: {
      type: "timestamp",
      desc: "Maximum accepted token-provided absolute grant expiration.",
    },
    default_rootfs_id: {
      type: "string",
      desc: "Optional default rootfs landing context for successful claims.",
    },
    max_claims: {
      type: "number",
      desc: "Maximum total successful claim consumptions for this pool.",
    },
    max_claims_per_account: {
      type: "number",
      desc: "Maximum successful claim consumptions per account for this pool.",
    },
    starts_at: {
      type: "timestamp",
      desc: "When this external claim pool becomes active.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this external claim pool expires.",
    },
    disabled_at: {
      type: "timestamp",
      desc: "When this external claim pool was disabled.",
    },
    metadata: {
      type: "map",
      desc: "Optional pool metadata.",
    },
    created_by_account_id: {
      type: "uuid",
      desc: "Account that created this external claim pool.",
      render: { type: "account" },
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "site_license_external_claim_keys",
  rules: {
    primary_key: "id",
    pg_indexes: ["pool_id", "kid", "alg", "expires_at", "revoked_at"],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          pool_id: null,
          kid: null,
          alg: null,
          public_key_jwk: null,
          public_key_pem: null,
          starts_at: null,
          expires_at: null,
          revoked_at: null,
          created_by_account_id: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          pool_id: null,
          kid: null,
          alg: null,
          public_key_jwk: null,
          public_key_pem: null,
          starts_at: null,
          expires_at: null,
          revoked_at: null,
          created_by_account_id: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique external claim key id.",
    },
    pool_id: {
      type: "uuid",
      desc: "External claim pool this public key belongs to.",
    },
    kid: {
      type: "string",
      desc: "Token header key id.",
    },
    alg: {
      type: "string",
      desc: "Allowed token signing algorithm for this key.",
    },
    public_key_jwk: {
      type: "map",
      desc: "Public key in JWK form.",
    },
    public_key_pem: {
      type: "string",
      desc: "Public key in PEM form.",
    },
    starts_at: {
      type: "timestamp",
      desc: "When this key becomes valid.",
    },
    expires_at: {
      type: "timestamp",
      desc: "When this key expires.",
    },
    revoked_at: {
      type: "timestamp",
      desc: "When this key was revoked.",
    },
    created_by_account_id: {
      type: "uuid",
      desc: "Account that added this key.",
      render: { type: "account" },
    },
    metadata: {
      type: "map",
      desc: "Optional key metadata.",
    },
    created: {
      type: "timestamp",
      desc: "Creation time.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});

Table({
  name: "site_license_external_claim_consumptions",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "pool_id",
      "site_license_id",
      "package_id",
      "jti",
      "token_hash",
      "issuer",
      "kid",
      "account_id",
      "status",
      "side_effect_key",
      "assignment_id",
      "membership_grant_id",
      "consumed_at",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          pool_id: null,
          site_license_id: null,
          package_id: null,
          jti: null,
          token_hash: null,
          issuer: null,
          kid: null,
          account_id: null,
          status: null,
          side_effect_key: null,
          assignment_id: null,
          membership_grant_id: null,
          membership_class: null,
          membership_expires_at: null,
          rootfs_id: null,
          external_subject: null,
          token_expires_at: null,
          error_code: null,
          error_message: null,
          retry_count: null,
          last_retry_at: null,
          metadata: null,
          consumed_at: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          id: null,
          pool_id: null,
          site_license_id: null,
          package_id: null,
          jti: null,
          token_hash: null,
          issuer: null,
          kid: null,
          account_id: null,
          status: null,
          side_effect_key: null,
          assignment_id: null,
          membership_grant_id: null,
          membership_class: null,
          membership_expires_at: null,
          rootfs_id: null,
          external_subject: null,
          token_expires_at: null,
          error_code: null,
          error_message: null,
          retry_count: null,
          last_retry_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Unique external claim consumption id.",
    },
    pool_id: {
      type: "uuid",
      desc: "External claim pool that accepted this token.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Site license containing the pool.",
    },
    package_id: {
      type: "uuid",
      desc: "Membership package backing this claim.",
    },
    jti: {
      type: "string",
      desc: "One-time token identifier unique within the pool.",
    },
    token_hash: {
      type: "string",
      desc: "Server-side hash of the raw token; never the raw token.",
    },
    issuer: {
      type: "string",
      desc: "Verified token issuer.",
    },
    kid: {
      type: "string",
      desc: "Verified token key id.",
    },
    account_id: {
      type: "uuid",
      desc: "Account that consumed this token.",
      render: { type: "account" },
    },
    status: {
      type: "string",
      desc: "Consumption state: pending-side-effect, granted, failed-retryable, or failed-terminal.",
    },
    side_effect_key: {
      type: "string",
      desc: "Deterministic idempotency key for account-home grant side effects.",
    },
    assignment_id: {
      type: "uuid",
      desc: "Membership package assignment created or found by the side effect.",
    },
    membership_grant_id: {
      type: "uuid",
      desc: "Membership grant created or found by the side effect.",
    },
    membership_class: {
      type: "string",
      desc: "Membership class requested by this claim.",
    },
    membership_expires_at: {
      type: "timestamp",
      desc: "Membership grant expiration requested by this claim.",
    },
    rootfs_id: {
      type: "string",
      desc: "Optional rootfs landing context from the claim or pool.",
    },
    external_subject: {
      type: "string",
      desc: "Publisher/customer/order subject from the verified token.",
    },
    token_expires_at: {
      type: "timestamp",
      desc: "Token expiration time.",
    },
    error_code: {
      type: "string",
      desc: "Last side-effect error code, if any.",
    },
    error_message: {
      type: "string",
      desc: "Last side-effect error message, if any.",
    },
    retry_count: {
      type: "number",
      desc: "Number of side-effect retries.",
    },
    last_retry_at: {
      type: "timestamp",
      desc: "Most recent side-effect retry time.",
    },
    metadata: {
      type: "map",
      desc: "Sanitized token and operator metadata.",
    },
    consumed_at: {
      type: "timestamp",
      desc: "When the seed authority consumed the token jti.",
    },
    updated: {
      type: "timestamp",
      desc: "Last updated time.",
    },
  },
});
