/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// These tables contain financial authority, paid entitlements, security
// configuration, or immutable audit state. Browser mutations must use their
// dedicated RPCs so authorization, invariants, audit, and routing are applied
// consistently.
export const DOMAIN_API_ONLY_USER_QUERY_MUTATION_TABLES = new Set<string>([
  "account_entitlement_overrides",
  "admin_assigned_memberships",
  "billing_authority_account_fences",
  "billing_authority_commands",
  "billing_authority_lease",
  "crm_accounts",
  "crm_purchases",
  "crm_subscriptions",
  "legacy_migration_account_links",
  "legacy_migration_accounts",
  "legacy_migration_financial_claims",
  "legacy_migration_project_import_accounts",
  "legacy_migration_project_imports",
  "legacy_migration_projects",
  "membership_claim_identities",
  "membership_claim_scopes",
  "membership_grants",
  "membership_package_assignments",
  "membership_packages",
  "project_entitlement_overrides",
  "public_project_paths",
  "server_settings",
  "site_license_audit_log",
  "site_license_external_claim_consumptions",
  "site_license_external_claim_keys",
  "site_license_external_claim_pools",
  "site_license_managers",
  "site_license_pool_requests",
  "site_licenses",
  "site_settings",
  "team_license_seat_lines",
  "team_licenses",
]);

export function userQueryMutationRequiresDomainApi(table: string): boolean {
  return DOMAIN_API_ONLY_USER_QUERY_MUTATION_TABLES.has(table);
}
