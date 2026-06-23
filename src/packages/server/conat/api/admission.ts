/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type HubApiAdmissionDecision = {
  allowed: boolean;
  source: "hub-api" | "hub-api-low-priority";
  reason?: string;
  maximum: number;
};

const LOW_PRIORITY_METHODS = new Set([
  "purchases.getAIUsage",
  "purchases.getAccountUsageOverview",
  "purchases.getMembershipDetails",
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
  key,
}: {
  active: number;
  maximum: number;
  key: unknown;
}): HubApiAdmissionDecision {
  const max = Math.max(1, Math.floor(Number(maximum)));
  const current = Math.max(0, Math.floor(Number(active)));
  const lowPriority = isLowPriorityHubApiMethod(key);
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
