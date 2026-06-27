/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "legacy_migration_accounts",
  rules: {
    primary_key: "legacy_account_id",
    pg_indexes: [
      "email_address",
      "stripe_customer_id",
      "last_active",
      "email_address_verified",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_account_id: null,
          email_address: null,
          email_address_verified: null,
          first_name: null,
          last_name: null,
          display_name: null,
          stripe_customer_id: null,
          last_active: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_account_id: null,
          email_address: null,
          email_address_verified: null,
          first_name: null,
          last_name: null,
          display_name: null,
          stripe_customer_id: null,
          last_active: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    legacy_account_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable account id from legacy cocalc.com.",
    },
    email_address: {
      type: "string",
      pg_type: "VARCHAR(254)",
      desc: "Primary legacy account email address, normalized to lowercase when known.",
      render: { type: "email_address" },
    },
    email_address_verified: {
      type: "boolean",
      desc: "Whether the legacy email address was verified on cocalc.com.",
    },
    first_name: {
      type: "string",
      desc: "Legacy first name.",
    },
    last_name: {
      type: "string",
      desc: "Legacy last name.",
    },
    display_name: {
      type: "string",
      desc: "Best display name from the legacy account dump.",
    },
    stripe_customer_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Best Stripe customer id associated with this legacy account, when known.",
    },
    last_active: {
      type: "timestamp",
      desc: "Last known activity time on cocalc.com.",
    },
    metadata: {
      type: "map",
      desc: "Raw or auxiliary legacy account metadata needed for support.",
    },
    created: {
      type: "timestamp",
      desc: "When this catalog row was imported.",
    },
    updated: {
      type: "timestamp",
      desc: "When this catalog row was last updated.",
    },
  },
});

Table({
  name: "legacy_migration_financial_claims",
  rules: {
    primary_key: "legacy_account_id",
    pg_indexes: [
      "account_id",
      "status",
      "credit_purchase_id",
      "subscription_id",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_account_id: null,
          account_id: null,
          status: null,
          credit_amount: null,
          credit_purchase_id: null,
          selected_membership_class: null,
          selected_membership_interval: null,
          subscription_id: null,
          stripe_customer_id: null,
          applied_at: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_account_id: null,
          account_id: null,
          status: null,
          credit_amount: null,
          credit_purchase_id: null,
          selected_membership_class: null,
          selected_membership_interval: null,
          subscription_id: null,
          stripe_customer_id: null,
          applied_at: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    legacy_account_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Legacy account id whose financial migration has been claimed. A legacy account can be financially claimed only once.",
    },
    account_id: {
      type: "uuid",
      desc: "CoCalc-ai account that claimed this legacy account's financial migration.",
      render: { type: "account" },
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Financial migration status: applying, applied, skipped, or failed.",
    },
    credit_amount: {
      type: "number",
      pg_type: "numeric(20,10)",
      desc: "Total credit applied for this legacy account, including positive cash balance and computed remaining paid legacy entitlement value.",
    },
    credit_purchase_id: {
      type: "integer",
      desc: "CoCalc-ai purchases.id row for the migrated credit, if any.",
    },
    selected_membership_class: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Membership tier selected when applying this financial migration.",
    },
    selected_membership_interval: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Membership billing interval selected when applying this financial migration.",
    },
    subscription_id: {
      type: "integer",
      desc: "CoCalc-ai subscriptions.id created for the selected migrated membership, if any.",
    },
    stripe_customer_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Legacy Stripe customer id copied to the new account when applying this migration.",
    },
    applied_at: {
      type: "timestamp",
      desc: "When this financial migration was applied.",
    },
    metadata: {
      type: "map",
      desc: "Audit details for the financial migration preview and application.",
    },
    created: {
      type: "timestamp",
      desc: "When this financial claim row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this financial claim row was last updated.",
    },
  },
});

Table({
  name: "legacy_migration_account_links",
  rules: {
    primary_key: ["legacy_account_id", "account_id"],
    pg_indexes: ["account_id", "claim_method", "created"],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_account_id: null,
          account_id: null,
          claim_method: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_account_id: null,
          account_id: null,
          claim_method: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    legacy_account_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable account id from legacy cocalc.com.",
    },
    account_id: {
      type: "uuid",
      desc: "CoCalc-ai account that claimed or was matched to the legacy account.",
      render: { type: "account" },
    },
    claim_method: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "How the link was established, e.g. verified-email, legacy-session, support.",
    },
    metadata: {
      type: "map",
      desc: "Auxiliary verification/audit metadata for this account link.",
    },
    created: {
      type: "timestamp",
      desc: "When this link was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this link was last updated.",
    },
  },
});

Table({
  name: "legacy_migration_projects",
  rules: {
    primary_key: "legacy_project_id",
    pg_indexes: [
      "owner_legacy_account_id",
      "artifact_status",
      "last_edited",
      "disk_mb",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_project_id: null,
          title: null,
          description: null,
          owner_legacy_account_id: null,
          legacy_users: null,
          hidden: null,
          last_edited: null,
          last_active: null,
          disk_mb: null,
          artifact_bucket: null,
          artifact_key: null,
          manifest_key: null,
          artifact_status: null,
          artifact_manifest: null,
          metadata: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_project_id: null,
          title: null,
          description: null,
          owner_legacy_account_id: null,
          legacy_users: null,
          hidden: null,
          last_edited: null,
          last_active: null,
          disk_mb: null,
          artifact_bucket: null,
          artifact_key: null,
          manifest_key: null,
          artifact_status: null,
          artifact_manifest: null,
          metadata: null,
        },
      },
    },
  },
  fields: {
    legacy_project_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable project id from legacy cocalc.com.",
    },
    title: {
      type: "string",
      desc: "Legacy project title.",
    },
    description: {
      type: "string",
      desc: "Legacy project description.",
    },
    owner_legacy_account_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Best legacy owner account id, when known.",
    },
    legacy_users: {
      type: "map",
      desc: "Legacy project users keyed by legacy account id, including role metadata.",
    },
    hidden: {
      type: "boolean",
      desc: "Whether the project was hidden/deleted from the user's normal legacy listing.",
    },
    last_edited: {
      type: "timestamp",
      desc: "Last legacy project edit time.",
    },
    last_active: {
      type: "timestamp",
      desc: "Last legacy project activity time.",
    },
    disk_mb: {
      type: "number",
      desc: "Last known cocalc.com project disk usage in megabytes, from project status.disk_MB.",
    },
    artifact_bucket: {
      type: "string",
      desc: "R2 bucket holding the latest archived project tarball.",
    },
    artifact_key: {
      type: "string",
      desc: "R2 key for the latest archived project tarball.",
    },
    manifest_key: {
      type: "string",
      desc: "R2 key for the project archive manifest JSON.",
    },
    artifact_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Archive availability: available, missing, or unknown.",
    },
    artifact_manifest: {
      type: "map",
      desc: "Parsed latest archive manifest, when available.",
    },
    metadata: {
      type: "map",
      desc: "Raw or auxiliary legacy project metadata needed for support.",
    },
    created: {
      type: "timestamp",
      desc: "When this catalog row was imported.",
    },
    updated: {
      type: "timestamp",
      desc: "When this catalog row was last updated.",
    },
  },
});

Table({
  name: "legacy_migration_project_imports",
  rules: {
    primary_key: "legacy_project_id",
    pg_indexes: [
      "project_id",
      "owner_account_id",
      "status",
      "restore_status",
      "restore_claimed_until",
      "restore_lro_op_id",
      "updated",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_project_id: null,
          project_id: null,
          owner_account_id: null,
          status: null,
          restore_mode: null,
          restore_status: null,
          restore_error: null,
          restore_attempts: null,
          restore_worker_id: null,
          restore_claimed_until: null,
          restore_started: null,
          restore_finished: null,
          restore_lro_op_id: null,
          restore_progress: null,
          restore_result: null,
          rootfs_image: null,
          rootfs_image_id: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_project_id: null,
          project_id: null,
          owner_account_id: null,
          status: null,
          restore_mode: null,
          restore_status: null,
          restore_error: null,
          restore_attempts: null,
          restore_worker_id: null,
          restore_claimed_until: null,
          restore_started: null,
          restore_finished: null,
          restore_lro_op_id: null,
          restore_progress: null,
          restore_result: null,
          rootfs_image: null,
          rootfs_image_id: null,
        },
      },
    },
  },
  fields: {
    legacy_project_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable project id from legacy cocalc.com.",
    },
    project_id: {
      type: "uuid",
      desc: "CoCalc-ai project created for this legacy project.",
      render: { type: "uuid" },
    },
    owner_account_id: {
      type: "uuid",
      desc: "CoCalc-ai account that first imported and owns the migrated project.",
      render: { type: "account" },
    },
    status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Metadata import status: creating, imported, or failed.",
    },
    restore_mode: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Restore mode: full for automatic whole-archive restore, or select for host-cached selective restore.",
    },
    restore_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "File restore status from R2: pending, restoring, restored, skipped, selection-pending, indexing, indexed, or failed.",
    },
    restore_error: {
      type: "string",
      desc: "Last file restore error, if any.",
    },
    restore_attempts: {
      type: "integer",
      desc: "Number of file restore worker attempts.",
    },
    restore_worker_id: {
      type: "string",
      pg_type: "VARCHAR(64)",
      desc: "Worker id currently or most recently handling file restore.",
    },
    restore_claimed_until: {
      type: "timestamp",
      desc: "Restore worker lease expiration time.",
    },
    restore_started: {
      type: "timestamp",
      desc: "When the current or most recent restore attempt started.",
    },
    restore_finished: {
      type: "timestamp",
      desc: "When the restore finished or failed.",
    },
    restore_lro_op_id: {
      type: "uuid",
      desc: "Long-running operation id for the current or most recent full file restore.",
    },
    restore_progress: {
      type: "map",
      desc: "Latest summarized full file restore progress for user-facing status.",
    },
    restore_result: {
      type: "map",
      desc: "Host-side restore result metadata, including archive bytes and checksum.",
    },
    rootfs_image: {
      type: "string",
      desc: "Runtime image selected for the migrated project.",
    },
    rootfs_image_id: {
      type: "string",
      desc: "RootFS image catalog id selected for the migrated project.",
    },
    created: {
      type: "timestamp",
      desc: "When this migration row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this migration row was last updated.",
    },
  },
});

Table({
  name: "legacy_migration_project_import_accounts",
  rules: {
    primary_key: ["legacy_project_id", "account_id"],
    pg_indexes: ["account_id", "project_id", "created"],
    user_query: {
      get: {
        admin: true,
        fields: {
          legacy_project_id: null,
          account_id: null,
          project_id: null,
          legacy_account_id: null,
          role: null,
          created: null,
          updated: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          legacy_project_id: null,
          account_id: null,
          project_id: null,
          legacy_account_id: null,
          role: null,
        },
      },
    },
  },
  fields: {
    legacy_project_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable project id from legacy cocalc.com.",
    },
    account_id: {
      type: "uuid",
      desc: "CoCalc-ai account that imported or joined this migrated project.",
      render: { type: "account" },
    },
    project_id: {
      type: "uuid",
      desc: "CoCalc-ai project for this legacy project.",
      render: { type: "uuid" },
    },
    legacy_account_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Legacy account id that authorized this import.",
    },
    role: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Role granted on the target project.",
    },
    created: {
      type: "timestamp",
      desc: "When this account joined the migrated project.",
    },
    updated: {
      type: "timestamp",
      desc: "When this account import row was last updated.",
    },
  },
});
