/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type HubApiAdmissionDecision = {
  allowed: boolean;
  source:
    | "hub-api"
    | "hub-api-low-priority"
    | "hub-api-account"
    | "hub-api-account-low-priority";
  reason?: string;
  maximum: number;
};

const LOW_PRIORITY_METHODS = new Set([
  "compute.getCatalog",
  "compute.listAgentGrants",
  "compute.listVms",
  "compute.listVolumes",
  "growthAnalytics.recordEvent",
  "purchases.getAIUsage",
  "purchases.getAccountUsageOverview",
  "purchases.getManagedEgressAdminHistory",
  "purchases.getManagedEgressAdminOverview",
  "purchases.getManagedEgressHistory",
  "purchases.getMembershipDetails",
  "system.listNews",
  "system.recordUxLatencyEvent",
  "system.removeBrowserSession",
  "system.upsertBrowserSession",
  "system.webappError",
]);

export function isLowPriorityHubApiMethod(name: unknown): boolean {
  return LOW_PRIORITY_METHODS.has(`${name ?? ""}`);
}

export function getHubApiReservedCapacity(maximum: number): number {
  const max = Math.floor(Number(maximum));
  if (!Number.isFinite(max) || max <= 1) return 0;
  const target = Math.ceil(max * 0.2);
  const reserve = max < 100 ? target : Math.max(20, target);
  return Math.min(max - 1, reserve);
}

export function getHubApiLowPriorityMaximum(maximum: number): number {
  const max = Math.max(1, Math.floor(Number(maximum)));
  return Math.max(1, max - getHubApiReservedCapacity(max));
}

export function getHubApiAdmissionDecision({
  active,
  maximum,
  accountActive,
  accountMaximum,
  key,
}: {
  active: number;
  maximum: number;
  accountActive?: number;
  accountMaximum?: number;
  key: unknown;
}): HubApiAdmissionDecision {
  const max = Math.max(1, Math.floor(Number(maximum)));
  const current = Math.max(0, Math.floor(Number(active)));
  const lowPriority = isLowPriorityHubApiMethod(key);
  if (accountActive != null && accountMaximum != null) {
    const accountCurrent = Math.max(0, Math.floor(Number(accountActive) || 0));
    const accountMax = Math.max(1, Math.floor(Number(accountMaximum) || 1));
    const accountLowPriorityMax = getHubApiLowPriorityMaximum(accountMax);
    if (lowPriority && accountCurrent >= accountLowPriorityMax) {
      return {
        allowed: false,
        source: "hub-api-account-low-priority",
        maximum: accountLowPriorityMax,
        reason: "hub api per-account low-priority request budget is exhausted",
      };
    }
    if (accountCurrent >= accountMax) {
      return {
        allowed: false,
        source: "hub-api-account",
        maximum: accountMax,
        reason: "hub api per-account request budget is exhausted",
      };
    }
  }
  if (lowPriority) {
    const lowPriorityMaximum = getHubApiLowPriorityMaximum(max);
    if (current >= lowPriorityMaximum) {
      return {
        allowed: false,
        source: "hub-api-low-priority",
        maximum: lowPriorityMaximum,
        reason: "hub api low-priority request budget is exhausted",
      };
    }
  }
  if (current >= max) {
    return {
      allowed: false,
      source: lowPriority ? "hub-api-low-priority" : "hub-api",
      maximum: max,
      reason: "hub api server is busy",
    };
  }
  return {
    allowed: true,
    source: lowPriority ? "hub-api-low-priority" : "hub-api",
    maximum: max,
  };
}
