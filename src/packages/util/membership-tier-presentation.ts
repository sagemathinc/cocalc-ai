/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { currency, humanSize, plural, round2 } from "./misc";
import { upgrades } from "./upgrade-spec";

export interface MembershipTierPresentationInput {
  id: string;
  label?: string;
  price_monthly?: unknown;
  price_yearly?: unknown;
  trial_days?: unknown;
  course_price?: unknown;
  course_duration_days?: unknown;
  course_grace_days?: unknown;
  course_store_visible?: boolean;
  project_defaults?: unknown;
  ai_limits?: unknown;
  features?: unknown;
  usage_limits?: unknown;
}

export interface MembershipTierPresentation {
  tagline: string;
  summaryBenefits: string[];
  summaryLimits: string[];
  benefits: string[];
  limits: string[];
  billing: string[];
}

const DEFAULT_TAGLINES: Record<string, string> = {
  free: "A light entry point for evaluation and occasional use.",
  student: "A class-focused membership for course access.",
  member: "The standard paid membership for serious day-to-day work.",
  instructor: "More headroom for teaching, courses, and many collaborators.",
  researcher: "Higher compute and image limits for research workloads.",
  pro: "Higher limits for heavier workloads and demanding technical projects.",
};

const PROJECT_LIMIT_KEYS = ["memory", "disk_quota", "mintime"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  if (value != null && typeof value === "object") {
    const decimalValue = (value as { toNumber?: () => number }).toNumber?.();
    if (Number.isFinite(decimalValue)) return decimalValue;
  }
  return undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null || !(numberValue > 0)) return undefined;
  return Math.floor(numberValue);
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return "";
  if (hours < 1) {
    const minutes = Math.max(1, Math.round(hours * 60));
    return `${minutes} ${plural(minutes, "minute")}`;
  }
  const rounded = Number.isInteger(hours) ? hours : round2(hours);
  return `${rounded} ${plural(rounded, "hour")}`;
}

function formatQuotaValue(key: string, value: unknown): string {
  const spec = (upgrades as any).params?.[key];
  if (spec?.input_type === "checkbox") {
    return value ? "included" : "not included";
  }
  const numberValue = asNumber(value);
  if (numberValue == null) {
    return `${value}`;
  }
  if (key === "memory" || key === "disk_quota") {
    if (numberValue >= 1000) {
      const gb = numberValue / 1000;
      return `${Number.isInteger(gb) ? gb : round2(gb)} GB`;
    }
    return `${numberValue} MB`;
  }
  const displayValue =
    spec?.display_factor != null
      ? numberValue * spec.display_factor
      : numberValue;
  if (key === "mintime") {
    return formatHours(displayValue);
  }
  const rounded = Number.isInteger(displayValue)
    ? displayValue
    : round2(displayValue);
  const unit = spec?.display_unit ?? spec?.unit ?? "";
  return unit ? `${rounded} ${unit}` : `${rounded}`;
}

function projectLimitLabel(key: string): string {
  switch (key) {
    case "memory":
      return "Project RAM";
    case "disk_quota":
      return "Per-project disk quota";
    case "mintime":
      return "Minimum project uptime";
    default:
      return key;
  }
}

export function buildMembershipTierPresentation(
  tier: MembershipTierPresentationInput,
): MembershipTierPresentation {
  const projectDefaults = asRecord(tier.project_defaults);
  const aiLimits = asRecord(tier.ai_limits);
  const features = asRecord(tier.features);
  const usageLimits = asRecord(tier.usage_limits);
  const summaryBenefits: string[] = [];
  const summaryLimits: string[] = [];
  const benefits: string[] = [];
  const limits: string[] = [];
  const billing: string[] = [];

  const tierLabel = tier.label ?? tier.id;
  const tagline =
    DEFAULT_TAGLINES[tier.id] ??
    `Membership benefits configured for ${tierLabel}.`;

  const sharedHostTier = asNumber(features.project_host_tier);
  if (projectDefaults.member_host || sharedHostTier != null) {
    const hostPoolBenefit =
      sharedHostTier != null && sharedHostTier > 0
        ? `Shared project-host pool access, tier ${sharedHostTier}.`
        : "Shared project-host pool access.";
    summaryBenefits.push(hostPoolBenefit);
    benefits.push(hostPoolBenefit);
  }
  if (features.create_hosts) {
    benefits.push(
      sharedHostTier != null && sharedHostTier > 0
        ? `Can rent custom project hosts with tier ${sharedHostTier} host access.`
        : "Can rent custom project hosts.",
    );
  }

  const sponsoredProjects = asPositiveInteger(
    usageLimits.max_sponsored_running_projects,
  );
  if (sponsoredProjects != null && sponsoredProjects > 0) {
    const sponsoredBenefit = `Up to ${sponsoredProjects} simultaneous sponsored running ${plural(
      sponsoredProjects,
      "project",
    )}.`;
    summaryBenefits.push(sponsoredBenefit);
    benefits.push(sponsoredBenefit);
  }

  const ai5h = asNumber(aiLimits.units_5h ?? aiLimits.limit_5h);
  const ai7d = asNumber(aiLimits.units_7d ?? aiLimits.limit_7d);
  if (ai5h != null && ai5h > 0) {
    benefits.push("Included AI usage allowance.");
  }

  const rootfsCount = asPositiveInteger(usageLimits.rootfs_count);
  if (rootfsCount != null) {
    benefits.push(
      `Create up to ${rootfsCount} custom RootFS ${plural(rootfsCount, "image")}.`,
    );
  }
  if (usageLimits.rootfs_oci_images) {
    benefits.push("Advanced OCI RootFS image import.");
  }
  if (usageLimits.invite_email_send_enabled) {
    benefits.push("Email invitations for projects and courses.");
  }

  const sharedComputePriority = asNumber(usageLimits.shared_compute_priority);
  if (sharedComputePriority != null) {
    const limit = `Shared compute priority: ${sharedComputePriority}`;
    summaryLimits.push(limit);
    limits.push(limit);
  }

  if (sponsoredProjects != null) {
    limits.push(`Sponsored running projects: up to ${sponsoredProjects}`);
  }

  const totalStorageHard = asNumber(usageLimits.total_storage_hard_bytes);
  if (totalStorageHard != null && totalStorageHard > 0) {
    const limit = `Total storage hard cap: ${humanSize(totalStorageHard)}`;
    summaryLimits.push(limit);
    limits.push(limit);
  }
  const totalStorageSoft = asNumber(usageLimits.total_storage_soft_bytes);
  if (totalStorageSoft != null && totalStorageSoft > 0) {
    limits.push(`Total storage soft cap: ${humanSize(totalStorageSoft)}`);
  }

  for (const key of PROJECT_LIMIT_KEYS) {
    if (key in projectDefaults) {
      const limit = `${projectLimitLabel(key)}: ${formatQuotaValue(key, projectDefaults[key])}`;
      if (key === "memory" || key === "disk_quota") {
        summaryLimits.push(limit);
      }
      limits.push(limit);
    }
  }
  if (ai5h != null && ai5h > 0) {
    limits.push(`AI: ${round2(ai5h)} units per 5 hours`);
  }
  if (ai7d != null && ai7d > 0) {
    limits.push(`AI: ${round2(ai7d)} units per rolling 7 days`);
  }

  const maxProjects = asPositiveInteger(usageLimits.max_projects);
  if (maxProjects != null) {
    limits.push(`Projects: up to ${maxProjects}`);
  }

  const egress5h = asNumber(usageLimits.egress_5h_bytes);
  if (egress5h != null && egress5h > 0) {
    limits.push(`Managed egress: ${humanSize(egress5h)} per 5 hours`);
  }
  const egress7d = asNumber(usageLimits.egress_7d_bytes);
  if (egress7d != null && egress7d > 0) {
    limits.push(`Managed egress: ${humanSize(egress7d)} per 7 days`);
  }

  const rootfsStorage = asNumber(usageLimits.rootfs_total_storage_gb);
  const rootfsMax = asNumber(usageLimits.rootfs_max_storage_gb);
  if (rootfsCount != null || rootfsStorage != null || rootfsMax != null) {
    const pieces: string[] = [];
    if (rootfsCount != null) pieces.push(`${rootfsCount} images`);
    if (rootfsStorage != null) pieces.push(`${rootfsStorage} GB total`);
    if (rootfsMax != null) pieces.push(`${rootfsMax} GB per image`);
    limits.push(`RootFS: ${pieces.join(", ")}`);
  }

  const collaborators = asPositiveInteger(
    usageLimits.project_max_collaborators_and_pending_invites,
  );
  if (collaborators != null) {
    limits.push(
      `Project collaborators and pending invites: up to ${collaborators}`,
    );
  }

  const prepaidHost7d = asNumber(usageLimits.prepaid_host_usage_limit_7d_usd);
  const creditSpend7d = asNumber(usageLimits.credit_spend_limit_7d_usd);
  if (prepaidHost7d != null && prepaidHost7d > 0) {
    limits.push(
      `Prepaid host spending guardrail: ${currency(prepaidHost7d)} per 7 days`,
    );
  }
  if (creditSpend7d != null && creditSpend7d > 0) {
    limits.push(
      `Credit spending guardrail: ${currency(creditSpend7d)} per 7 days`,
    );
  }

  const monthly = asNumber(tier.price_monthly);
  const yearly = asNumber(tier.price_yearly);
  if (monthly != null) {
    billing.push(`${currency(monthly)} per month`);
  }
  if (yearly != null) {
    const yearlyText = `${currency(yearly)} per year`;
    if (monthly != null && monthly > 0 && yearly > 0 && monthly * 12 > yearly) {
      const savings = Math.round((1 - yearly / (monthly * 12)) * 100);
      billing.push(`${yearlyText} (about ${savings}% less than monthly)`);
    } else {
      billing.push(yearlyText);
    }
  }

  const trialDays = asPositiveInteger(tier.trial_days);
  if (trialDays != null) {
    billing.push(
      `${trialDays}-day free trial for eligible new subscription purchases.`,
    );
  }

  const coursePrice = asNumber(tier.course_price);
  const courseDays = asPositiveInteger(tier.course_duration_days);
  if (tier.course_store_visible && coursePrice != null && courseDays != null) {
    billing.push(
      `Course option: ${currency(coursePrice)} for ${courseDays} ${plural(
        courseDays,
        "day",
      )}.`,
    );
  }
  const courseGraceDays = asPositiveInteger(tier.course_grace_days);
  if (tier.course_store_visible && courseGraceDays != null) {
    billing.push(
      `Course grace period: ${courseGraceDays} ${plural(courseGraceDays, "day")}.`,
    );
  }

  return {
    tagline,
    summaryBenefits: summaryBenefits.slice(0, 4),
    summaryLimits: summaryLimits.slice(0, 5),
    benefits: benefits.slice(0, 7),
    limits: limits.slice(0, 10),
    billing,
  };
}
