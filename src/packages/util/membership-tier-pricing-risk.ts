/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export type MembershipTierRiskSeverity = "ok" | "notice" | "warning" | "danger";

export interface MembershipTierPricingAssumptions {
  targetGrossMargin: number;
  overheadReserve: number;
  aiUnitCostUsd: number;
  egressCostPerGb: number;
  blobStorageCostPerGbMonth: number;
  rootfsStorageCostPerGbMonth: number;
  sharedHostMonthlyCostUsd: number;
  sharedHostUsableRamGb: number;
  sharedHostUsableVcpu: number;
  targetRamOversubscription: number;
  targetCpuOversubscription: number;
  activeProjectConcurrency: number;
}

export interface MembershipTierPricingInput {
  priceMonthlyUsd?: unknown;
  priceYearlyUsd?: unknown;
  aiUnits7d?: unknown;
  egress7dGb?: unknown;
  blobStorageGb?: unknown;
  rootfsStorageGb?: unknown;
  creditSpendLimit7dUsd?: unknown;
  prepaidHostUsageLimit7dUsd?: unknown;
  cpu7dHours?: unknown;
  projectMemoryMb?: unknown;
  maxSponsoredRunningProjects?: unknown;
}

export interface MembershipTierRiskMessage {
  severity: MembershipTierRiskSeverity;
  message: string;
}

export interface MembershipTierPricingRiskAnalysis {
  monthlyRevenueUsd: number;
  annualizedMonthlyRevenueUsd: number;
  targetHardCostBudgetUsd: number;
  hardCosts: {
    aiMonthlyUsd: number;
    egressMonthlyUsd: number;
    blobStorageMonthlyUsd: number;
    rootfsStorageMonthlyUsd: number;
    dedicatedHostCreditGuardrailMonthlyUsd: number;
    prepaidHostGuardrailMonthlyUsd: number;
    totalMonthlyUsd: number;
  };
  capacity: {
    cpuHoursMonthlyBudget: number;
    averageCpuEntitlement: number;
    sharedHostCpuUserShare: number;
    activeProjectRamGb: number;
    sharedHostRamUserShare: number;
  };
  margin: {
    hardCostBudgetRemainingUsd: number;
    hardCostRatio: number;
  };
  messages: MembershipTierRiskMessage[];
}

const DAYS_PER_MONTH = 30;
const DAYS_PER_WEEK = 7;
const HOURS_PER_MONTH = DAYS_PER_MONTH * 24;
const MB_PER_GB = 1000;

export const DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS: MembershipTierPricingAssumptions =
  {
    targetGrossMargin: 0.7,
    overheadReserve: 0.1,
    aiUnitCostUsd: 0.01,
    egressCostPerGb: 0.05,
    blobStorageCostPerGbMonth: 0.025,
    rootfsStorageCostPerGbMonth: 0.04,
    sharedHostMonthlyCostUsd: 120,
    sharedHostUsableRamGb: 48,
    sharedHostUsableVcpu: 16,
    targetRamOversubscription: 1.5,
    targetCpuOversubscription: 8,
    activeProjectConcurrency: 1,
  };

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonnegative(value: unknown): number {
  return Math.max(0, numberOrZero(value));
}

function safePositive(value: unknown, fallback: number): number {
  const numberValue = numberOrZero(value);
  return numberValue > 0 ? numberValue : fallback;
}

function monthlyFromWeekly(value: unknown): number {
  return nonnegative(value) * (DAYS_PER_MONTH / DAYS_PER_WEEK);
}

function clampFraction(value: unknown): number {
  const numberValue = numberOrZero(value);
  if (numberValue < 0) return 0;
  if (numberValue > 1) return 1;
  return numberValue;
}

export function normalizeMembershipTierPricingAssumptions(
  assumptions: Partial<MembershipTierPricingAssumptions> | undefined,
): MembershipTierPricingAssumptions {
  const merged = {
    ...DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS,
    ...(assumptions ?? {}),
  };
  return {
    targetGrossMargin: clampFraction(merged.targetGrossMargin),
    overheadReserve: clampFraction(merged.overheadReserve),
    aiUnitCostUsd: nonnegative(merged.aiUnitCostUsd),
    egressCostPerGb: nonnegative(merged.egressCostPerGb),
    blobStorageCostPerGbMonth: nonnegative(merged.blobStorageCostPerGbMonth),
    rootfsStorageCostPerGbMonth: nonnegative(
      merged.rootfsStorageCostPerGbMonth,
    ),
    sharedHostMonthlyCostUsd: nonnegative(merged.sharedHostMonthlyCostUsd),
    sharedHostUsableRamGb: safePositive(
      merged.sharedHostUsableRamGb,
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS.sharedHostUsableRamGb,
    ),
    sharedHostUsableVcpu: safePositive(
      merged.sharedHostUsableVcpu,
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS.sharedHostUsableVcpu,
    ),
    targetRamOversubscription: safePositive(
      merged.targetRamOversubscription,
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS.targetRamOversubscription,
    ),
    targetCpuOversubscription: safePositive(
      merged.targetCpuOversubscription,
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS.targetCpuOversubscription,
    ),
    activeProjectConcurrency: safePositive(
      merged.activeProjectConcurrency,
      DEFAULT_MEMBERSHIP_TIER_PRICING_ASSUMPTIONS.activeProjectConcurrency,
    ),
  };
}

export function analyzeMembershipTierPricingRisk(
  input: MembershipTierPricingInput,
  rawAssumptions?: Partial<MembershipTierPricingAssumptions>,
): MembershipTierPricingRiskAnalysis {
  const assumptions = normalizeMembershipTierPricingAssumptions(rawAssumptions);
  const monthlyRevenueUsd = nonnegative(input.priceMonthlyUsd);
  const annualizedMonthlyRevenueUsd = nonnegative(input.priceYearlyUsd) / 12;
  const effectiveMonthlyRevenueUsd =
    monthlyRevenueUsd > 0 ? monthlyRevenueUsd : annualizedMonthlyRevenueUsd;
  const targetHardCostBudgetUsd =
    effectiveMonthlyRevenueUsd *
    Math.max(
      0,
      1 - assumptions.targetGrossMargin - assumptions.overheadReserve,
    );

  const aiMonthlyUsd =
    monthlyFromWeekly(input.aiUnits7d) * assumptions.aiUnitCostUsd;
  const egressMonthlyUsd =
    monthlyFromWeekly(input.egress7dGb) * assumptions.egressCostPerGb;
  const blobStorageMonthlyUsd =
    nonnegative(input.blobStorageGb) * assumptions.blobStorageCostPerGbMonth;
  const rootfsStorageMonthlyUsd =
    nonnegative(input.rootfsStorageGb) *
    assumptions.rootfsStorageCostPerGbMonth;
  const dedicatedHostCreditGuardrailMonthlyUsd = monthlyFromWeekly(
    input.creditSpendLimit7dUsd,
  );
  const prepaidHostGuardrailMonthlyUsd = monthlyFromWeekly(
    input.prepaidHostUsageLimit7dUsd,
  );
  const totalMonthlyUsd =
    aiMonthlyUsd +
    egressMonthlyUsd +
    blobStorageMonthlyUsd +
    rootfsStorageMonthlyUsd +
    dedicatedHostCreditGuardrailMonthlyUsd;

  const cpuHoursMonthlyBudget = monthlyFromWeekly(input.cpu7dHours);
  const averageCpuEntitlement = cpuHoursMonthlyBudget / HOURS_PER_MONTH;
  const sharedHostCpuUserShare =
    assumptions.sharedHostUsableVcpu * assumptions.targetCpuOversubscription;
  const runningProjects = Math.max(
    1,
    nonnegative(input.maxSponsoredRunningProjects) ||
      assumptions.activeProjectConcurrency,
  );
  const activeProjectRamGb =
    (nonnegative(input.projectMemoryMb) / MB_PER_GB) * runningProjects;
  const sharedHostRamUserShare =
    assumptions.sharedHostUsableRamGb * assumptions.targetRamOversubscription;
  const hardCostBudgetRemainingUsd = targetHardCostBudgetUsd - totalMonthlyUsd;
  const hardCostRatio =
    targetHardCostBudgetUsd > 0
      ? totalMonthlyUsd / targetHardCostBudgetUsd
      : totalMonthlyUsd > 0
        ? Number.POSITIVE_INFINITY
        : 0;

  const messages: MembershipTierRiskMessage[] = [];
  if (effectiveMonthlyRevenueUsd <= 0 && totalMonthlyUsd > 0) {
    messages.push({
      severity: "danger",
      message:
        "This tier has modeled hard-cost exposure but no recurring price.",
    });
  } else if (hardCostRatio > 1) {
    messages.push({
      severity: "danger",
      message: "Modeled hard-cost exposure is above the target budget.",
    });
  } else if (hardCostRatio > 0.75) {
    messages.push({
      severity: "warning",
      message: "Modeled hard-cost exposure is close to the target budget.",
    });
  } else {
    messages.push({
      severity: "ok",
      message: "Modeled hard-cost exposure is within the target budget.",
    });
  }

  if (averageCpuEntitlement > assumptions.sharedHostUsableVcpu) {
    messages.push({
      severity: "warning",
      message:
        "The CPU-hour budget averages above one shared host; this may be fine for dedicated or high-tier users, but it is not a typical shared-pool promise.",
    });
  }
  if (activeProjectRamGb > sharedHostRamUserShare) {
    messages.push({
      severity: "warning",
      message:
        "The simultaneous project RAM promise is above the modeled shared-host user share.",
    });
  }
  if (dedicatedHostCreditGuardrailMonthlyUsd > 0) {
    messages.push({
      severity: "notice",
      message:
        "Credit-based dedicated-host guardrails are exposure caps, not expected spend.",
    });
  }
  if (prepaidHostGuardrailMonthlyUsd > 0) {
    messages.push({
      severity: "notice",
      message:
        "Prepaid dedicated-host usage is excluded from hard-cost exposure; the main residual risk is payment reversal or chargeback.",
    });
  }

  return {
    monthlyRevenueUsd,
    annualizedMonthlyRevenueUsd,
    targetHardCostBudgetUsd,
    hardCosts: {
      aiMonthlyUsd,
      egressMonthlyUsd,
      blobStorageMonthlyUsd,
      rootfsStorageMonthlyUsd,
      dedicatedHostCreditGuardrailMonthlyUsd,
      prepaidHostGuardrailMonthlyUsd,
      totalMonthlyUsd,
    },
    capacity: {
      cpuHoursMonthlyBudget,
      averageCpuEntitlement,
      sharedHostCpuUserShare,
      activeProjectRamGb,
      sharedHostRamUserShare,
    },
    margin: {
      hardCostBudgetRemainingUsd,
      hardCostRatio,
    },
    messages,
  };
}
