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
  | "payer_account_id"
  | "sender_account_id"
  | "recipient_account_id"
  | "pool_id"
  | "project_id"
  | "host_id"
  | "connector_id"
  | "bay_id"
  | "owning_bay_id"
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
      "account_funding_authorities",
      "account_funding_holds",
      "compute_funding_pools",
      "compute_funding_grants",
      "compute_funding_reservations",
      "compute_funding_events",
      "compute_funding_purchase_attributions",
      "compute_vm_personal_consents",
    ],
    {
      ownership: "seed-global",
      authority: "seed",
      portability: "stable",
      notes:
        "Seed-authoritative sponsorship budgets, grants, reservations, events, attributions, and personal funding consents. Account rehome changes routing metadata but never moves or duplicates this financial state.",
    },
  ),
  ...entries(["compute_funding_exposure_policy"], {
    ownership: "stable-bay",
    authority: "bay_id",
    portability: "stable",
    notes:
      "Local accepted share of the independently signed cluster exposure manifest. Account moves do not move a bay's exposure budget or authorize a larger site-wide ceiling.",
  }),
  ...entries(
    [
      "admin_membership_orders",
      "billing_accounts",
      "billing_authority_account_fences",
      "billing_authority_commands",
      "billing_authority_lease",
      "billing_authority_migrations",
      "credit_payment_roots",
      "credit_transfer_deliveries",
      "credit_transfer_entries",
      "credit_transfer_ledger_observations",
      "credit_transfers",
      "payment_fulfillments",
      "provider_refund_attempts",
      "purchases",
      "statements",
      "subscription_renewal_attempts",
      "subscriptions",
      "team_license_seat_lines",
      "team_licenses",
    ],
    {
      ownership: "seed-global",
      authority: "seed",
      portability: "stable",
      notes:
        "Seed-authoritative billing accounts, ledgers, provider provenance, transfers, subscriptions, purchased entitlement sources, and command/fencing state. Generic account rehome and bay drain must not move or delete them.",
    },
  ),
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
      "admin_membership_package_intents",
      "api_keys",
      "membership_grants",
      "membership_package_assignments",
      "membership_packages",
      "notification_targets",
      "password_reset",
      "password_reset_attempts",
      "remember_me",
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

  ...entries(["membership_analytics_events"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    secondary_reference_fields: {
      bay_id: "Bay that recorded the analytics event, not ownership authority.",
    },
    notes:
      "Bay-local immutable membership analytics event ledger. Rows are written alongside account-home billing and membership lifecycle actions and are aggregated across bays for admin analytics.",
  }),

  ...entries(["membership_analytics_daily_counts"], {
    ownership: "projection",
    authority: "local",
    portability: "rebuildable",
    notes:
      "Bay-local daily membership count snapshots. These are derived from account-home membership state and aggregated across bays for admin analytics.",
  }),

  ...entries(["membership_allocation_facts"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    secondary_reference_fields: {
      bay_id: "Bay that recorded the allocation fact, not ownership authority.",
    },
    notes:
      "Immutable membership allocation facts recorded alongside account-home membership and billing actions. Facts contain account ids only for idempotency and reconciliation; reporting uses non-PII daily projections.",
  }),

  ...entries(
    ["membership_allocation_projections", "membership_daily_allocations"],
    {
      ownership: "projection",
      authority: "local",
      portability: "rebuildable",
      notes:
        "Bay-local derived membership allocation state rebuilt from immutable account-home facts and aggregated across bays for admin analytics.",
      rebuild:
        "Clear the projection markers and daily rows, then replay immutable membership allocation facts.",
    },
  ),

  ...entries(
    [
      "compute_revenue_analytics_state",
      "compute_revenue_daily",
      "compute_usage_daily",
    ],
    {
      ownership: "projection",
      authority: "local",
      portability: "rebuildable",
      notes:
        "Bay-local daily customer-funded compute revenue and usage projections. They contain no account identifiers and are aggregated across bays for admin analytics.",
      rebuild:
        "Clear the projection rows and maintenance watermark, then replay account-home purchases and immutable egress intervals.",
    },
  ),

  ...entries(
    ["account_managed_egress_events", "account_managed_egress_rollups"],
    {
      ownership: "account-home",
      authority: "account_id",
      portability: "unsupported",
      secondary_reference_fields: {
        project_id: "Usage attribution dimension, not placement authority.",
      },
      notes:
        "Account-home managed-egress event and rollup state. Reads and writes must route to the account home bay; account rehome is unsafe until this state has explicit migration support.",
    },
  ),

  ...entries(
    [
      "growth_account_activity_daily",
      "growth_account_milestones",
      "growth_account_profiles",
    ],
    {
      ownership: "account-home",
      authority: "account_id",
      portability: "unsupported",
      notes:
        "Canonical account growth facts. Writes must route to the account home bay; global dashboards consume aggregate projections rather than these account rows.",
    },
  ),

  ...entries(["growth_event_log"], {
    ownership: "audit-local",
    authority: "local",
    portability: "unsupported",
    secondary_reference_fields: {
      account_id:
        "Authenticated account reference; the row is retained only in the bay-local diagnostic ledger.",
      project_id:
        "Optional project context for the event, not project placement authority.",
    },
    notes:
      "Short-lived validated product-event ledger. The materializer converts these rows into account-home facts and bay-local aggregate projections before bounded retention cleanup.",
  }),

  ...entries(
    [
      "growth_dirty_periods",
      "growth_materialization_state",
      "growth_metric_series",
      "growth_retention_cells",
      "growth_weekly_accounting",
    ],
    {
      ownership: "projection",
      authority: "local",
      portability: "rebuildable",
      notes:
        "Bay-scoped growth materialization state and compact serving projections. These tables are restart-safe and rebuildable from account-home facts and the short-lived event log.",
    },
  ),

  ...entries(["growth_annotations"], {
    ownership: "stable-bay",
    authority: "local",
    portability: "stable",
    notes:
      "Admin-authored growth timeline annotations retained on the bay where they are created.",
  }),

  ...entries(["growth_onboarding_continuations"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    secondary_reference_fields: {
      project_id:
        "Continuation target for the account-home notification workflow, not project placement authority.",
    },
    notes:
      "Account-home onboarding continuation delivery state. Scheduling and delivery must route to the account home bay; account rehome is unsafe until this state has explicit migration support.",
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
      "project_archive_lifecycle_jobs",
      "project_collab_invite_blocks",
      "project_collab_invites",
      "project_entitlement_override_events",
      "project_entitlement_overrides",
      "project_events_outbox",
      "project_labels",
      "public_project_paths",
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
      "project_host_exam_configs",
      "project_host_exam_runs",
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
        owner_account_id:
          "Host owner or billing account reference, not host placement authority.",
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
      "active_user_map_history_countries",
      "active_user_map_history_snapshots",
      "buckets",
      "commercial_invoices",
      "commercial_order_contacts",
      "commercial_order_documents",
      "commercial_order_events",
      "commercial_order_items",
      "commercial_orders",
      "commercial_payments",
      "commercial_provider_operations",
      "commercial_quotes",
      "commercial_stripe_events",
      "commercial_worker_state",
      "crm_activities",
      "crm_contact_suppressions",
      "crm_external_references",
      "crm_metric_snapshots",
      "crm_mutation_events",
      "crm_opportunities",
      "crm_organization_domains",
      "crm_organization_people",
      "crm_organizations",
      "crm_outreach_batches",
      "crm_outreach_deliveries",
      "crm_outreach_engagement_events",
      "crm_outreach_provider_operations",
      "crm_outreach_templates",
      "crm_outreach_worker_state",
      "crm_outreach_zendesk_events",
      "crm_people",
      "crm_person_accounts",
      "crm_person_emails",
      "crm_tasks",
      "email_auth_challenges",
      "global_config_bay_state",
      "global_config_events",
      "global_config_versions",
      "hub_servers",
      "instances",
      "legacy_migration_account_link_events",
      "legacy_migration_account_links",
      "legacy_migration_accounts",
      "legacy_migration_financial_claims",
      "legacy_migration_project_import_accounts",
      "legacy_migration_project_imports",
      "legacy_migration_projects",
      "legacy_migration_public_share_replay_events",
      "lti",
      "membership_claim_identities",
      "membership_claim_scopes",
      "membership_tiers",
      "news",
      "organizations",
      "passport_settings",
      "passport_store",
      "project_backup_repos",
      "public_project_path_slugs",
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
      "webapp_error_resolutions",
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

  ...entries(["account_presence_locations", "cloud_vm_work"], {
    ownership: "ephemeral",
    authority: "local",
    portability: "rebuildable",
    notes:
      "Transient bay-local state. It must be safe to lose during bay drain or service restart.",
    rebuild:
      "Recreate from a later browser presence observation or durable worker source state.",
  }),

  ...entries(
    [
      "compute_vms",
      "compute_vm_project_access",
      "compute_vm_instances",
      "compute_volumes",
    ],
    {
      ownership: "stable-bay",
      authority: "owning_bay_id",
      portability: "stable",
      secondary_reference_fields: {
        owner_account_id:
          "The beneficiary owns the resource; account rehome does not relocate it.",
        project_id:
          "Revocable project access controls discovery and SSH data-plane access, but not authority.",
      },
      notes:
        "Managed resources remain at their owning bay across account rehome. Instance records inherit authority from their VM. Owner API calls route to this bay; funding is checked separately at the payer home. Revocable project access confers neither lifecycle nor billing authority.",
    },
  ),

  ...entries(["compute_egress_meter_intervals"], {
    ownership: "account-home",
    authority: "owner_account_id",
    portability: "portable",
    secondary_reference_fields: {
      project_id:
        "Usage context only; replay accounting belongs to its account owner.",
    },
    notes:
      "Account-owned metering replay evidence, moved with financial state. Physical resource identities remain unchanged.",
  }),
  ...entries(["compute_site_funded_usage"], {
    ownership: "stable-bay",
    authority: "local",
    portability: "stable",
    notes:
      "Site-funded provider usage evidence remains with the resource's worker bay, independently of its beneficiary's account home.",
  }),
  ...entries(["compute_vm_turn_grants"], {
    ownership: "account-home",
    authority: "owner_account_id",
    portability: "rebuildable",
    secondary_reference_fields: {
      project_id:
        "The capability is scoped to this project but approved by its account owner.",
    },
    notes:
      "Short-lived agent approvals are checked at the current account home. Account rehome requires a new approval there; old-bay approvals are not accepted or copied as financial consent.",
    rebuild:
      "A verified agent capability creates a fresh, initially read-only or unapproved request at the new home. Billable, destructive, and availability permissions require account approval again.",
  }),

  ...entries(["compute_vm_orphans"], {
    ownership: "stable-bay",
    authority: "local",
    portability: "stable",
    notes:
      "Durable provider/DNS orphan observations and delayed remediation state. The local authority bay must retain this across worker and hub restarts.",
  }),

  ...entries(["compute_resource_work"], {
    ownership: "stable-bay",
    authority: "local",
    portability: "stable",
    notes:
      "Resource-owning-bay provider work and pending lifecycle-notice delivery. Desired resource state can reconstruct provider intent, but not historical notification delivery. Retain undelivered funded work across restarts and account moves; it is not disposable queue state.",
  }),

  ...entries(["compute_resource_events"], {
    ownership: "audit-local",
    authority: "local",
    portability: "stable",
    notes: "Append-only managed compute lifecycle and authorization audit.",
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
  ...adHocEntries(["notification_course_credit_states"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "portable",
    source: "course-credit notification bootstrap",
    migrate_to_schema: true,
    notes:
      "Course-credit crossing state moves with account financial authority alongside its notification records, so retries and moves do not repeat threshold alerts.",
  }),
  ...adHocEntries(["account_financial_handoffs"], {
    ownership: "stable-bay",
    authority: "local",
    portability: "stable",
    source: "financial rehome coordinator bootstrap",
    migrate_to_schema: true,
    secondary_reference_fields: {
      account_id:
        "The account being moved, not authority to migrate the bay-local handoff journal.",
    },
    notes:
      "Bay-local source/destination handoff journal and fencing history. Each side retains its own durable operation state; the account's financial snapshot is transferred through this protocol rather than copying the coordinator journal.",
  }),
  ...adHocEntries(["course_funding_approval_intents"], {
    ownership: "account-home",
    authority: "payer_account_id",
    portability: "portable",
    source: "course funding trusted approval service",
    migrate_to_schema: true,
    notes:
      "Payer-home immutable approval and application receipts. Financial rehome preserves applied operations but expires pending browser approvals and removes their authenticated session binding; no fresh-auth capability migrates.",
  }),
  ...adHocEntries(["admin_support_mutations"], {
    ownership: "seed-global",
    authority: "seed",
    portability: "stable",
    secondary_reference_fields: {
      account_id:
        "Admin actor reference for auditing, not ownership authority.",
    },
    source: "admin support mutation ledger",
    migrate_to_schema: true,
    notes:
      "Cluster-global idempotency and audit state for Zendesk mutations. The seed bay is authoritative so retries resolve against one ledger across all bays.",
  }),

  ...adHocEntries(
    [
      "admin_data_explorer_views",
      "admin_support_mutations",
      "cluster_account_api_key_directory",
      "cluster_account_directory",
      "cluster_bay_credentials",
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

  ...adHocEntries(["account_usage_counters", "account_usage_counter_states"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    source: "server usage counter schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Account-scoped usage counter state keyed by account_usage_windows. Authority is inherited from the referenced window's account_id; these rows must move or be removed with that account's usage windows.",
  }),

  ...adHocEntries(["project_app_private_hostnames"], {
    ownership: "project-owning",
    authority: "project_id",
    portability: "unsupported",
    source: "server Postgres schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Private project-app hostname routes are authoritative on the project's owning bay. Cross-bay project rehome must release and recreate them until explicit portable DNS handoff exists.",
  }),

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
      "site_ai_account_holds",
      "site_ai_funding_periods",
      "site_ai_speech_reservations",
      "site_ai_turn_reservations",
    ],
    {
      ownership: "seed-global",
      authority: "seed",
      portability: "stable",
      source: "server site-funded AI reservation schema bootstrap",
      migrate_to_schema: true,
      notes:
        "Cluster-wide site-funded AI budget, hold, and reservation state. All admission and settlement operations route to the seed bay so concurrency and spending limits are enforced globally.",
    },
  ),

  ...adHocEntries(
    [
      "project_active_operations",
      "project_backup_repo_assignments",
      "project_collab_invite_inbox",
      "project_copies",
      "project_moves",
      "public_project_path_viewer_grants",
      "course_secret_audit_events",
      "course_secret_grants",
      "course_secret_policies",
      "course_secret_recipients",
      "course_secret_sync_results",
      "course_secret_sync_runs",
      "project_secret_managed_sources",
      "project_secrets",
      "project_secrets_runtime_state",
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

  ...adHocEntries(["project_site_migrations"], {
    ownership: "project-owning",
    authority: "project_id",
    portability: "unsupported",
    source: "server project-site migration schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Cross-site project migration control state keyed by destination_project_id. The destination project's owning bay is authoritative; source_project_id and destination_owner_account_id are references only.",
  }),

  ...adHocEntries(["public_project_path_site_license_grants"], {
    ownership: "project-owning",
    authority: "mixed",
    portability: "unsupported",
    source: "server public directory share schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Project public-directory share grant state keyed through public_project_paths. Reads/writes must follow the owning project path; rehome is unsafe until explicitly audited.",
  }),

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

  ...adHocEntries(["project_host_intrusion_snapshots"], {
    ownership: "audit-local",
    authority: "local",
    portability: "stable",
    secondary_reference_fields: {
      host_id: "Monitored host reference, not host placement authority.",
    },
    source: "server host intrusion monitor schema bootstrap",
    migrate_to_schema: true,
    notes:
      "Bay-local normalized host intrusion snapshots used for operator monitoring. They are diagnostic history, not authoritative host state.",
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
