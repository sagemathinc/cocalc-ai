/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type TableOwnershipClass =
  | "seed-global"
  | "account-home"
  | "project-owning"
  | "host-owning"
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
  | "bay_id"
  | "local"
  | "none"
  | "mixed";

export type TablePortabilityStatus =
  | "portable"
  | "rebuildable"
  | "stable"
  | "unsupported";

export interface TableOwnershipEntry {
  table: string;
  ownership: TableOwnershipClass;
  authority: TableAuthorityKey;
  portability: TablePortabilityStatus;
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
      "admin_assigned_memberships",
      "api_keys",
      "external_credentials",
      "membership_grants",
      "membership_package_assignments",
      "membership_packages",
      "notification_targets",
      "password_reset",
      "password_reset_attempts",
      "remember_me",
      "statements",
      "subscriptions",
      "usage_info",
    ],
    {
      ownership: "account-home",
      authority: "account_id",
      portability: "unsupported",
      notes:
        "Account-owned source-of-truth state. Reads/writes must route to the account home bay. Rehome remains unsafe until this table has explicit migration tests.",
    },
  ),

  ...entries(["purchases"], {
    ownership: "account-home",
    authority: "account_id",
    portability: "unsupported",
    notes:
      "Account-owned billing ledger state. This must never be dropped or reinitialized during rehome; current rehome behavior is intentionally treated as unsafe.",
  }),

  ...entries(
    [
      "bookmarks",
      "blobs",
      "cursors",
      "deleted_projects",
      "eval_inputs",
      "eval_outputs",
      "ipywidgets",
      "listings",
      "mentions",
      "messages",
      "patches",
      "project_access_request_blocks",
      "project_access_requests",
      "project_backup_repos",
      "project_collab_invite_blocks",
      "project_collab_invites",
      "project_events_outbox",
      "project_rootfs_states",
      "projects",
      "syncstrings",
    ],
    {
      ownership: "project-owning",
      authority: "project_id",
      portability: "unsupported",
      notes:
        "Project-owned source-of-truth state. Reads/writes must route to the project owning bay. Rehome requires explicit table-specific copy/delete verification.",
    },
  ),

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
      notes:
        "Project-host-owned control-plane state. Writes must route to the host bay; host rehome is an exceptional unsafe operation until audited.",
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
      "hub_servers",
      "instances",
      "lti",
      "membership_claim_identities",
      "membership_claim_scopes",
      "membership_tiers",
      "news",
      "organizations",
      "passport_settings",
      "passport_store",
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
      "site_license_managers",
      "site_license_pool_requests",
      "site_licenses",
      "software_license_events",
      "software_license_tiers",
      "software_licenses",
      "sso_domain_policies",
      "sso_providers",
      "voucher_codes",
      "vouchers",
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
      "self_host_commands",
      "self_host_connector_tokens",
      "self_host_connectors",
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

export function getTableOwnership(
  table: string,
): TableOwnershipEntry | undefined {
  return TABLE_OWNERSHIP[table];
}
