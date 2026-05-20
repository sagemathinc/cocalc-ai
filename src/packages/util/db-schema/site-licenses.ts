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
    owner_account_id: {
      type: "uuid",
      desc: "Account whose home bay owns this site license.",
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
      desc: "Manager role: owner, manager, or viewer.",
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
