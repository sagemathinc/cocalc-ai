/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type { BillingAuthorityCommand } from "./protocol";

const HTTP_READ_OPERATIONS = new Set([
  "get-billing-readiness",
  "get-customer",
  "get-invoice",
  "get-invoice-url",
  "get-payment-intent-account-id",
  "get-payment-method",
  "get-payment-methods",
  "get-unpaid-invoices",
]);

// New methods are commands unless they are deliberately reviewed and added
// here. All calls execute in the authority process; this allowlist only permits
// operations without financial side effects to run concurrently.
const PURCHASE_READ_METHODS = new Set([
  "adminGetMembershipPackageQuote",
  "getAIUsage",
  "getAccountUsageOverview",
  "getAdminActiveUsersOverview",
  "getAdminRetentionOverview",
  "getBalance",
  "getClaimableMembershipPackages",
  "getComputeRevenueSeries",
  "getManagedCpuAdminHistory",
  "getManagedCpuAdminOverview",
  "getManagedEgressAdminHistory",
  "getManagedEgressAdminOverview",
  "getManagedEgressHistory",
  "getMembership",
  "getMembershipAllocationSeries",
  "getMembershipAnalyticsEvents",
  "getMembershipAnalyticsOverview",
  "getMembershipPackageQuote",
  "getMembershipPackages",
  "getMembershipTierAdminOverview",
  "getMembershipTrialOffers",
  "getMinBalance",
  "getSiteLicenseAffiliationReverificationStatus",
  "getSiteLicenseOverview",
  "getTeamLicense",
  "getTeamLicenseQuote",
  "listAbuseReviewAnnotations",
  "listSiteLicenseExternalClaimConsumptions",
  "listSiteLicenseExternalClaimKeys",
  "listSiteLicenseExternalClaimPools",
  "listSiteLicenseOverviews",
  "searchSiteLicensePoolAccounts",
]);

const COMMERCIAL_ORDER_READ_METHODS = new Set([
  "createPreview",
  "diagnostics",
  "downloadDocument",
  "events",
  "fulfillmentPreview",
  "get",
  "invoicePreview",
  "list",
  "listAssignees",
  "quoteDocument",
  "quotePreview",
  "reconcilePreview",
  "siteLicenseRevenueAnalytics",
  "stripeQuotePreview",
]);

const LEGACY_MIGRATION_FINANCIAL_METHODS = new Set([
  "applyFinancialMigration",
  "configureFinancialMembershipRenewal",
]);

export function isBillingAuthorityHubApiCall(name: string): boolean {
  const [group, method] = name.split(".");
  return (
    group === "purchases" ||
    group === "commercialOrders" ||
    (group === "legacyMigration" &&
      LEGACY_MIGRATION_FINANCIAL_METHODS.has(method))
  );
}

export function isBillingAuthorityHubApiRead(name: string): boolean {
  const [group, method] = name.split(".");
  if (group === "purchases") return PURCHASE_READ_METHODS.has(method);
  if (group === "commercialOrders") {
    return COMMERCIAL_ORDER_READ_METHODS.has(method);
  }
  return false;
}

export function isBillingAuthorityHttpRead(operation: string): boolean {
  return HTTP_READ_OPERATIONS.has(operation);
}

export function isBillingAuthorityReadCommand(
  command: BillingAuthorityCommand | unknown,
): boolean {
  if (command == null || typeof command !== "object") return false;
  const candidate = command as {
    kind?: unknown;
    call?: { name?: unknown };
    operation?: unknown;
  };
  if (candidate.kind === "hub-api") {
    const name = candidate.call?.name;
    return typeof name === "string" && isBillingAuthorityHubApiRead(name);
  }
  if (candidate.kind === "http") {
    const operation = candidate.operation;
    return (
      typeof operation === "string" && isBillingAuthorityHttpRead(operation)
    );
  }
  return false;
}
