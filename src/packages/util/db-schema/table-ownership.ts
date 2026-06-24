/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type TableOwnershipClass =
  | "seed-global"
  | "account-home"
  | "project-owning"
  | "host-owning"
  | "row-scoped"
  | "stable-bay"
  | "projection"
  | "cache"
  | "audit-local"
  | "ephemeral";

export type TableAuthorityKey =
  | "seed"
  | "account_id"
  | "owner_account_id"
  | "project_id"
  | "host_id"
  | "connector_id"
  | "bay_id"
  | "local"
  | "none"
  | "mixed";

export type TablePortabilityStatus =
  | "portable"
  | "rebuildable"
  | "stable"
  | "unsupported";

export type TableReferenceField =
  | "account_id"
  | "owner_account_id"
  | "project_id"
  | "host_id"
  | "connector_id"
  | "bay_id";

export interface TableOwnershipEntry {
  table: string;
  ownership: TableOwnershipClass;
  authority: TableAuthorityKey;
  portability: TablePortabilityStatus;
  secondary_reference_fields?: Partial<Record<TableReferenceField, string>>;
  notes: string;
  rebuild?: string;
}

function entries(
  tables: string[],
  entry: Omit<TableOwnershipEntry, "table">,
): Record<string, TableOwnershipEntry> {
  return Object.fromEntries(
    tables.map((table) => [table, { table, ...entry }]),
  );
}

export const TABLE_OWNERSHIP = {
  ...entries(
    [
      "accounts",
      "account_auth_challenges",
      "account_auth_sessions",
      "account_ban_audit_log",
      "account_cli_auth_challenges",
      "account_entitlement_override_events",
      "account_entitlement_overrides",
      "account_impersonation_grants",
      "account_impersonation_sessions",
      "account_resource_quarantine_audit_log",
      "account_second_factor_recovery_codes",
      "account_second_factors",
      "api_keys",
      "membership_grants",
      "membership_package_assignments",
      "membership_packages",
      "notification_targets",
      "password_reset",
      "password_reset_attempts",
      "remember_me",
      "subscriptions",
      "team_licenses",
      "team_license_seat_lines",
      "usage_info",
    ],
    {
      ownership: "account-home",
      authority: "account_id",
      portability: "unsupported",
      secondary_reference_fields: {
        project_id:
          "Project reference for account-scoped usage, purchase, or credential rows.",
      },
      notes:
        "Account-owned source-of-truth state. Reads/writes must route to the account home bay. Rehome remains unsafe until this table has explicit migration tests.",
    },
  ),

  ...entries(["admin_assigned_memberships"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "portable",
    notes:
      "Account-home admin membership assignment. The assigned_by field is only an admin actor reference. Admin UI reads/writes route to the target account home bay, and account rehome copies this table.",
  }),

  ...entries(["purchases"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    secondary_reference_fields: {
      project_id:
        "Project reference for project-linked purchases, not placement authority.",
    },
    notes:
      "Account-owned commercial ledger state and current balance source input. Current writes route through account-home billing paths, but the long-term target is likely seed-global immutable ledger state with account-home projections. This must never be dropped, reinitialized, or moved by generic rehome/drain tooling.",
  }),

  ...entries(["statements"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    notes:
      "Account-owned statement and balance snapshot state derived from purchases and tied to payment reconciliation. Current writes route through account-home billing paths, but the long-term target is likely seed-global immutable commercial statement state with account-home projections. This must never be dropped, reinitialized, or moved by generic rehome/drain tooling.",
  }),

  ...entries(["external_credentials"], {
    ownership: "row-scoped",
    authority: "mixed",
    portability: "unsupported",
    secondary_reference_fields: {
      owner_account_id:
        "Authority key for account-scoped credential rows; reads/writes route to the account home bay.",
      project_id:
        "Authority key for project-scoped credential rows; reads/writes route to the project owning bay.",
    },
    notes:
      "External credential authority is determined by each row selector scope: account rows live on account home, project rows live on project owning bay, and site/organization rows live on the seed bay. Callers must use the external-credential routing helper instead of direct local store access.",
  }),

  ...entries(
    [
      "bookmarks",
      "blobs",
      "deleted_projects",
      "eval_inputs",
      "eval_outputs",
      "ipywidgets",
      "listings",
      "mentions",
      "messages",
      "project_access_request_blocks",
      "project_access_requests",
      "project_backup_indexes",
      "project_collab_invite_blocks",
      "project_collab_invites",
      "project_events_outbox",
      "project_labels",
      "project_rootfs_builds",
      "project_rootfs_states",
      "projects",
    ],
    {
      ownership: "project-owning",
      authority: "project_id",
      portability: "unsupported",
      secondary_reference_fields: {
        account_id: "Actor or owner reference, not placement authority.",
        host_id: "Host that produced or currently serves the project record.",
        owner_account_id: "Account reference, not placement authority.",
      },
      notes:
        "Project-owned source-of-truth state. Reads/writes must route to the project owning bay. Rehome requires explicit table-specific copy/delete verification.",
    },
  ),

  ...entries(["cursors", "patches", "syncstrings"], {
    ownership: "ephemeral",
    authority: "none",
    portability: "rebuildable",
    notes:
      "Legacy Postgres sync table. It is no longer used for live project sync state; current sync state lives in Conat on the project host. Rows are expected to be empty/obsolete and may be ignored or dropped during drain/rehome.",
    rebuild:
      "No rebuild required; live sync state is not sourced from this table.",
  }),

  ...entries(
    [
      "project_host_access",
      "project_host_bootstrap_tokens",
      "project_host_route_invalidations",
      "project_hosts",
      "project_runtime_slots",
    ],
    {
      ownership: "host-owning",
      authority: "host_id",
      portability: "unsupported",
      secondary_reference_fields: {
        account_id:
          "Account reference for access or allocation, not host placement authority.",
        project_id:
          "Project reference for access or allocation, not host placement authority.",
      },
      notes:
        "Project-host-owned control-plane state. Writes must route to the host bay; host rehome is an exceptional unsafe operation until audited.",
    },
  ),

  ...entries(
    [
      "self_host_commands",
      "self_host_connector_tokens",
      "self_host_connectors",
    ],
    {
      ownership: "host-owning",
      authority: "connector_id",
      portability: "unsupported",
      secondary_reference_fields: {
        account_id:
          "Owner or actor reference for pairing/connector actions, not placement authority.",
        host_id:
          "Attached project-host reference when known; the connector id is the stable self-host subresource key.",
      },
      notes:
        "Self-host connector state is durable host-owned control-plane state. It must live on the host bay and is not portable until host rehome explicitly copies connector records, active pairing tokens, and any in-flight command state.",
    },
  ),

  ...entries(
    [
      "buckets",
      "crm_leads",
      "crm_organizations",
      "crm_people",
      "crm_support_messages",
      "crm_support_tickets",
      "crm_tags",
      "crm_tasks",
      "global_config_bay_state",
      "global_config_events",
      "global_config_versions",
      "hub_servers",
      "instances",
      "legacy_migration_account_links",
      "legacy_migration_accounts",
      "legacy_migration_project_import_accounts",
      "legacy_migration_project_imports",
      "legacy_migration_projects",
      "lti",
      "membership_claim_identities",
      "membership_claim_scopes",
      "membership_tiers",
      "news",
      "organizations",
      "passport_settings",
      "passport_store",
      "project_backup_repos",
      "registration_tokens",
      "rootfs_image_events",
      "rootfs_images",
      "rootfs_release_artifacts",
      "rootfs_release_scan_reports",
      "rootfs_release_scan_runs",
      "rootfs_releases",
      "rootfs_rustic_repos",
      "server_settings",
      "site_license_audit_log",
      "site_license_external_claim_consumptions",
      "site_license_external_claim_keys",
      "site_license_external_claim_pools",
      "site_license_managers",
      "site_license_pool_requests",
      "site_licenses",
      "software_license_events",
      "software_license_tiers",
      "software_licenses",
      "sso_domain_policies",
      "sso_providers",
      "whitelabeling",
    ],
    {
      ownership: "seed-global",
      authority: "seed",
      portability: "stable",
      notes:
        "Cluster-global source-of-truth state. The seed bay is authoritative; non-seed copies, if any, are mirrors or caches and must not accept independent admin writes.",
    },
  ),

  ...entries(
    [
      "account_collaborator_index",
      "account_notification_index",
      "account_project_index",
    ],
    {
      ownership: "projection",
      authority: "mixed",
      portability: "rebuildable",
      notes:
        "Derived lookup/index state. It may live where it is useful for reads, but source-of-truth ownership stays with the underlying account/project tables.",
      rebuild:
        "Recompute from account/project/collaboration source tables after placement changes.",
    },
  ),

  ...entries(
    [
      "cloud_catalog_cache",
      "cloud_pricing_cache",
      "cloud_reconcile_state",
      "email_counter",
      "notification_email_outbox",
      "notification_events_outbox",
      "notification_target_outbox",
      "support_ticket_attempts",
    ],
    {
      ownership: "cache",
      authority: "local",
      portability: "rebuildable",
      notes:
        "Operational cache, queue, or rate-limiter state. It should tolerate loss, replay, or reconstruction and must not be the only copy of durable customer state.",
      rebuild:
        "Regenerate from upstream service state or accept bounded duplicate/retry behavior.",
    },
  ),

  ...entries(["analytics", "crm_retention", "stats"], {
    ownership: "cache",
    authority: "none",
    portability: "rebuildable",
    notes:
      "Aggregate analytics state. It is useful operationally but is not authoritative customer/account/project state.",
    rebuild:
      "Recompute from logs where available, or accept partial historical loss.",
  }),

  ...entries(
    [
      "account_admin_audit_log",
      "ai_usage_log",
      "central_log",
      "client_error_log",
      "cloud_vm_log",
      "cloud_vm_usage",
      "instance_actions_log",
      "membership_side_effects_outbox",
      "notification_events",
      "webapp_errors",
    ],
    {
      ownership: "audit-local",
      authority: "local",
      portability: "stable",
      notes:
        "Append-only or diagnostic operational history. It is intentionally bay-local unless product/legal requirements promote it to seed-global or account-owned state.",
    },
  ),

  ...entries(["cloud_vm_work"], {
    ownership: "ephemeral",
    authority: "local",
    portability: "rebuildable",
    notes:
      "Transient worker coordination state. It must be safe to lose during bay drain or service restart.",
    rebuild: "Workers may recreate or requeue work from durable source state.",
  }),
} satisfies Record<string, TableOwnershipEntry>;

export interface AdHocPostgresTableOwnershipEntry extends TableOwnershipEntry {
  source: string;
  migrate_to_schema: boolean;
}

function adHocEntries(
  tables: string[],
  entry: Omit<AdHocPostgresTableOwnershipEntry, "table">,
): Record<string, AdHocPostgresTableOwnershipEntry> {
  return Object.fromEntries(
    tables.map((table) => [table, { table, ...entry }]),
  );
}

export const AD_HOC_POSTGRES_TABLE_OWNERSHIP = {
  ...adHocEntries(
    [
      "admin_data_explorer_views",
      "cluster_account_api_key_directory",
      "cluster_account_directory",
      "cluster_bay_registry",
      "project_app_public_subdomains",
      "project_collab_invite_directory",
      "site_license_domain_locks",
      "site_license_domains",
    ],
    {
      ownership: "seed-global",
      authority: "seed",
      portability: "stable",
      source: "server Postgres schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Cluster-global directory/configuration state created outside util/db-schema. Seed should be authoritative; this should move into db-schema or a formal migration.",
    },
  ),

  ...adHocEntries(["legacy_migration_raw_records"], {
    ownership: "seed-global",
    authority: "seed",
    portability: "stable",
    source: "legacy migration dump importer",
    migrate_to_schema: false,
    notes:
      "Temporary raw cocalc.com migration dump rows keyed by source and legacy id. This is diagnostic/import staging data for the global legacy migration dataset and should be deleted with the migration subsystem.",
  }),

  ...adHocEntries(["account_impersonation_grant_directory"], {
    ownership: "projection",
    authority: "mixed",
    portability: "rebuildable",
    source: "server Postgres schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Cluster lookup directory for impersonation grants. It should be rebuildable from authoritative account-home grant rows.",
    rebuild:
      "Recompute from account_impersonation_grants across account homes.",
  }),

  ...adHocEntries(
    [
      "account_abuse_review_annotations",
      "account_cpu_usage_events",
      "account_managed_egress_events",
      "account_revocations",
      "account_security_state",
      "account_usage_windows",
    ],
    {
      ownership: "account-home",
      authority: "account_id",
      portability: "unsupported",
      secondary_reference_fields: {
        host_id: "Usage attribution dimension, not placement authority.",
        project_id: "Usage attribution dimension, not placement authority.",
      },
      source: "server Postgres schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Account-scoped durable operational state created outside util/db-schema. Reads/writes must route to the account home bay; rehome is unsafe until explicitly audited.",
    },
  ),

  ...adHocEntries(["ai_sessions"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    secondary_reference_fields: {
      host_id: "Runtime location for the observed session, not host authority.",
      project_id:
        "Project context for the observed session, not project ownership.",
    },
    source: "server AI session visibility schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Account-scoped Codex/ACP session visibility state created outside util/db-schema. Account-home routing owns user-visible session history; host/project/payment fields are observability dimensions.",
  }),

  ...adHocEntries(["account_usage_epochs", "account_usage_epoch_resets"], {
    ownership: "seed-global",
    authority: "seed",
    portability: "stable",
    source: "server Postgres schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Global usage-window epoch/reset state. This defines cluster-wide reset semantics and should be seed-authoritative.",
  }),

  ...adHocEntries(
    [
      "project_active_operations",
      "project_backup_repo_assignments",
      "project_collab_invite_inbox",
      "project_copies",
      "project_moves",
      "project_secrets",
    ],
    {
      ownership: "project-owning",
      authority: "project_id",
      portability: "unsupported",
      secondary_reference_fields: {
        account_id: "Actor or participant reference, not placement authority.",
      },
      source: "server Postgres schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Project-scoped durable operational state created outside util/db-schema. Reads/writes must route to the project owning bay; rehome is unsafe until explicitly audited.",
    },
  ),

  ...adHocEntries(
    ["project_host_availability_events", "project_host_rehome_operations"],
    {
      ownership: "host-owning",
      authority: "host_id",
      portability: "unsupported",
      source: "server Postgres schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Project-host-scoped operational state created outside util/db-schema. Host rehome/drain tools must treat it explicitly.",
    },
  ),

  ...adHocEntries(
    [
      "account_rehome_operations",
      "long_running_operations",
      "parallel_ops_limits",
      "project_rehome_operations",
    ],
    {
      ownership: "stable-bay",
      authority: "local",
      portability: "stable",
      secondary_reference_fields: {
        account_id: "Operation target reference, not placement authority.",
        host_id: "Operation target reference, not placement authority.",
        project_id: "Operation target reference, not placement authority.",
      },
      source: "server Postgres schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Operator/control-plane operation state that is currently stable on the bay where it is created. Whole-bay evacuation must inspect it explicitly.",
    },
  ),

  ...adHocEntries(["ux_latency_events"], {
    ownership: "audit-local",
    authority: "local",
    portability: "stable",
    secondary_reference_fields: {
      account_id: "User attribution dimension, not account-home authority.",
      host_id: "Host attribution dimension, not host placement authority.",
      project_id: "Project attribution dimension, not project ownership.",
    },
    source: "server monitoring schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Bay-local UX latency telemetry used for operational monitoring and launch tuning. It is diagnostic history, not authoritative account/project/host state.",
  }),

  ...adHocEntries(["launch_smoke_results"], {
    ownership: "audit-local",
    authority: "local",
    portability: "stable",
    secondary_reference_fields: {
      account_id: "Admin actor attribution, not account-home authority.",
      project_id: "Smoke-test target reference, not project ownership.",
    },
    source: "server monitoring schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Bay-local synthetic launch smoke telemetry used for operator health checks. It records diagnostic probe history, not authoritative project state.",
  }),

  ...adHocEntries(
    [
      "bay_restore_test_pitr_events",
      "cloudflare_r2_audit_cache",
      "cloudflare_teardown_plans",
      "provider_setup_challenges",
    ],
    {
      ownership: "cache",
      authority: "local",
      portability: "rebuildable",
      source: "server Postgres schema bootstrap",
      migrate_to_schema: false,
      notes:
        "Operational cache, challenge, or verification state. It may remain outside db-schema if documented as non-authoritative and drain-safe.",
      rebuild:
        "Regenerate from provider state, retry workflow, or accept bounded loss.",
    },
  ),

  ...adHocEntries(["membership_trial_claims"], {
    ownership: "seed-global",
    authority: "seed",
    portability: "stable",
    source: "server Postgres schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Global trial-claim ledger keyed by normalized email/account identity. It should be seed-authoritative to avoid duplicate claims across bays.",
  }),
} satisfies Record<string, AdHocPostgresTableOwnershipEntry>;

export const POSTGRES_TABLE_OWNERSHIP = {
  ...TABLE_OWNERSHIP,
  ...AD_HOC_POSTGRES_TABLE_OWNERSHIP,
} satisfies Record<string, TableOwnershipEntry>;

export function getTableOwnership(
  table: string,
): TableOwnershipEntry | undefined {
  return POSTGRES_TABLE_OWNERSHIP[table];
}
