/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { currency, humanSize, plural, round2 } from "./misc";

export interface MembershipTierPresentationInput {
  id: string;
  label?: string;
  price_monthly?: unknown;
  price_yearly?: unknown;
  trial_days?: unknown;
  store_description?: string;
  store_highlights?: readonly string[];
  site_license_pool_description?: string;
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
  detailGroups: MembershipTierDetailGroup[];
}

export interface MembershipTierDetail {
  key: string;
  label: string;
  value: string;
  help?: string;
}

export interface MembershipTierDetailGroup {
  key: string;
  title: string;
  details: MembershipTierDetail[];
}

const DEFAULT_TAGLINES: Record<string, string> = {
  free: "A light entry point for evaluation and occasional use.",
  basic:
    "An affordable paid membership for individual learning and light work.",
  student: "A class-focused membership for course access.",
  standard: "The standard paid membership for serious day-to-day work.",
  instructor: "More headroom for teaching, courses, and many collaborators.",
  researcher: "Higher compute and image limits for research workloads.",
  pro: "Higher limits for heavier workloads and demanding technical projects.",
};

const PROJECT_LIMIT_KEYS = ["memory", "memory_request", "disk_quota"] as const;

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

function formatQuotaValue(key: string, value: unknown): string {
  const numberValue = asNumber(value);
  if (numberValue == null) {
    return `${value}`;
  }
  if (key === "memory" || key === "memory_request" || key === "disk_quota") {
    if (numberValue >= 1000) {
      const gb = numberValue / 1000;
      return `${Number.isInteger(gb) ? gb : round2(gb)} GB`;
    }
    return `${numberValue} MB`;
  }
  const rounded = Number.isInteger(numberValue)
    ? numberValue
    : round2(numberValue);
  return `${rounded}`;
}

function projectLimitLabel(key: string): string {
  switch (key) {
    case "memory":
      return "Project RAM";
    case "memory_request":
      return "Project requested RAM";
    case "disk_quota":
      return "Per-project disk quota";
    default:
      return key;
  }
}

type DetailGroupKey =
  | "compute-projects"
  | "network"
  | "storage"
  | "ai-automation"
  | "collaboration"
  | "images"
  | "dedicated-hosts"
  | "billing";

const DETAIL_GROUP_TITLES: Record<DetailGroupKey, string> = {
  "compute-projects": "Compute and projects",
  network: "Network transfer",
  storage: "Storage and backups",
  "ai-automation": "AI and Codex automation",
  collaboration: "Collaboration and courses",
  images: "RootFS images and blobs",
  "dedicated-hosts": "Dedicated project hosts",
  billing: "Billing",
};

function formatCount(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue.toLocaleString();
}

function formatBoolean(value: unknown): string | undefined {
  if (typeof value !== "boolean") return;
  return value ? "Yes" : "No";
}

function formatBytes(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue > 0 ? humanSize(numberValue) : "Not included";
}

function formatCpuSeconds(value: unknown): string | undefined {
  const seconds = asNumber(value);
  if (seconds == null) return;
  if (seconds <= 0) return "Not included";
  const hours = seconds / 3600;
  return `${round2(hours).toLocaleString()} CPU-${hours === 1 ? "hour" : "hours"}`;
}

function formatGb(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue > 0 ? `${round2(numberValue)} GB` : "Not included";
}

function formatLimitCount(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue > 0 ? numberValue.toLocaleString() : "Not included";
}

function formatMoneyLimit(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue > 0 ? currency(numberValue) : "Not available";
}

function formatAiUnits(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue == null) return;
  return numberValue > 0
    ? `${round2(numberValue).toLocaleString()} units`
    : "Not included";
}

function formatComputePriority(value: unknown): string | undefined {
  const priority = asNumber(value);
  if (priority == null) return;
  return priority.toLocaleString();
}

function formatPolicy(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return;
  return value
    .split("-")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function buildMembershipTierDetailGroups({
  tier,
  projectDefaults,
  aiLimits,
  features,
  usageLimits,
}: {
  tier: MembershipTierPresentationInput;
  projectDefaults: Record<string, unknown>;
  aiLimits: Record<string, unknown>;
  features: Record<string, unknown>;
  usageLimits: Record<string, unknown>;
}): MembershipTierDetailGroup[] {
  const groups = new Map<DetailGroupKey, MembershipTierDetail[]>();
  const add = ({
    group,
    help,
    key,
    label,
    value,
  }: {
    group: DetailGroupKey;
    help?: string;
    key: string;
    label: string;
    value?: string;
  }) => {
    if (value == null) return;
    const details = groups.get(group) ?? [];
    details.push({ key, label, value, help });
    groups.set(group, details);
  };

  add({
    group: "compute-projects",
    key: "shared_compute_priority",
    label: "Shared compute priority",
    value: formatComputePriority(usageLimits.shared_compute_priority),
    help: "Relative scheduling priority on shared project hosts.",
  });
  add({
    group: "compute-projects",
    key: "project_host_tier",
    label: "Shared public project-host tier",
    value:
      asNumber(features.project_host_tier) == null
        ? undefined
        : `Tier ${asNumber(features.project_host_tier)}`,
    help: "Highest tier of shared public project host this membership may use.",
  });
  add({
    group: "compute-projects",
    key: "project_memory",
    label: "RAM per project",
    value:
      projectDefaults.memory == null
        ? undefined
        : formatQuotaValue("memory", projectDefaults.memory),
  });
  add({
    group: "compute-projects",
    key: "project_memory_request",
    label: "Requested RAM per project",
    value:
      (asNumber(projectDefaults.memory_request) ?? 0) > 0
        ? formatQuotaValue("memory_request", projectDefaults.memory_request)
        : undefined,
  });
  add({
    group: "compute-projects",
    key: "max_projects",
    label: "Owned projects",
    value: formatLimitCount(usageLimits.max_projects),
  });
  add({
    group: "ai-automation",
    key: "max_named_agents",
    label: "Named agents",
    value: formatLimitCount(usageLimits.max_named_agents),
  });
  add({
    group: "ai-automation",
    key: "max_agent_network_members",
    label: "Agent Network members",
    value: formatLimitCount(usageLimits.max_agent_network_members),
  });
  add({
    group: "compute-projects",
    key: "max_sponsored_running_projects",
    label: "Simultaneous sponsored running projects",
    value: formatLimitCount(usageLimits.max_sponsored_running_projects),
  });
  add({
    group: "compute-projects",
    key: "cpu_5h_seconds",
    label: "Managed CPU, rolling 5 hours",
    value: formatCpuSeconds(usageLimits.cpu_5h_seconds),
  });
  add({
    group: "compute-projects",
    key: "cpu_7d_seconds",
    label: "Managed CPU, rolling 7 days",
    value: formatCpuSeconds(usageLimits.cpu_7d_seconds),
  });

  add({
    group: "network",
    key: "egress_5h_bytes",
    label: "Managed network transfer, rolling 5 hours",
    value: formatBytes(usageLimits.egress_5h_bytes),
  });
  add({
    group: "network",
    key: "egress_7d_bytes",
    label: "Managed network transfer, rolling 7 days",
    value: formatBytes(usageLimits.egress_7d_bytes),
  });
  add({
    group: "network",
    key: "egress_policy",
    label: "Shared-host network policy",
    value: formatPolicy(usageLimits.egress_policy),
  });
  add({
    group: "network",
    key: "public_directory_shares",
    label: "Published directory shares",
    value: formatLimitCount(usageLimits.public_directory_shares),
  });

  add({
    group: "storage",
    key: "project_disk_quota",
    label: "Disk quota per project",
    value:
      projectDefaults.disk_quota == null
        ? undefined
        : formatQuotaValue("disk_quota", projectDefaults.disk_quota),
  });
  add({
    group: "storage",
    key: "total_storage_soft_bytes",
    label: "Total account storage soft cap",
    value: formatBytes(usageLimits.total_storage_soft_bytes),
  });
  add({
    group: "storage",
    key: "total_storage_hard_bytes",
    label: "Total account storage hard cap",
    value: formatBytes(usageLimits.total_storage_hard_bytes),
  });
  add({
    group: "storage",
    key: "max_snapshots_per_project",
    label: "Snapshots per project",
    value: formatLimitCount(usageLimits.max_snapshots_per_project),
  });
  add({
    group: "storage",
    key: "max_backups_per_project",
    label: "Backups per project",
    value: formatLimitCount(usageLimits.max_backups_per_project),
  });

  add({
    group: "ai-automation",
    key: "ai_units_5h",
    label: "Included AI usage, rolling 5 hours",
    value: formatAiUnits(aiLimits.units_5h ?? aiLimits.limit_5h),
  });
  add({
    group: "ai-automation",
    key: "ai_units_7d",
    label: "Included AI usage, rolling 7 days",
    value: formatAiUnits(aiLimits.units_7d ?? aiLimits.limit_7d),
  });
  add({
    group: "ai-automation",
    key: "acp_max_queued_per_account",
    label: "Queued agent turns per account",
    value: formatLimitCount(usageLimits.acp_max_queued_per_account),
  });
  add({
    group: "ai-automation",
    key: "acp_max_queued_per_thread",
    label: "Queued agent turns per thread",
    value: formatLimitCount(usageLimits.acp_max_queued_per_thread),
  });
  add({
    group: "ai-automation",
    key: "acp_max_created_5h_per_account",
    label: "Agent turns created, rolling 5 hours",
    value: formatLimitCount(usageLimits.acp_max_created_5h_per_account),
  });
  add({
    group: "ai-automation",
    key: "acp_max_created_7d_per_account",
    label: "Agent turns created, rolling 7 days",
    value: formatLimitCount(usageLimits.acp_max_created_7d_per_account),
  });
  add({
    group: "ai-automation",
    key: "acp_max_running_per_account",
    label: "Running agent turns per account",
    value: formatLimitCount(usageLimits.acp_max_running_per_account),
  });
  add({
    group: "ai-automation",
    key: "acp_max_running_per_project",
    label: "Running agent turns per project",
    value: formatLimitCount(usageLimits.acp_max_running_per_project),
  });
  add({
    group: "ai-automation",
    key: "acp_max_active_automations_per_project",
    label: "Active automations per project",
    value: formatLimitCount(usageLimits.acp_max_active_automations_per_project),
  });

  add({
    group: "collaboration",
    key: "project_max_collaborators_and_pending_invites",
    label: "Project collaborators and pending invitations",
    value: formatLimitCount(
      usageLimits.project_max_collaborators_and_pending_invites,
    ),
  });
  add({
    group: "collaboration",
    key: "course_max_students_and_pending_invites",
    label: "Course students and pending invitations",
    value: formatLimitCount(
      usageLimits.course_max_students_and_pending_invites,
    ),
  });
  add({
    group: "collaboration",
    key: "invite_email_send_enabled",
    label: "Invitation email sending",
    value: formatBoolean(usageLimits.invite_email_send_enabled),
  });
  add({
    group: "collaboration",
    key: "notification_email_send_limit_5h",
    label: "Notification emails, rolling 5 hours",
    value: formatLimitCount(usageLimits.notification_email_send_limit_5h),
  });
  add({
    group: "collaboration",
    key: "notification_email_send_limit_7d",
    label: "Notification emails, rolling 7 days",
    value: formatLimitCount(usageLimits.notification_email_send_limit_7d),
  });
  add({
    group: "collaboration",
    key: "invite_email_hourly_count",
    label: "Invitation emails per hour",
    value: formatLimitCount(usageLimits.invite_email_hourly_count),
  });
  add({
    group: "collaboration",
    key: "invite_email_daily_count",
    label: "Invitation emails per day",
    value: formatLimitCount(usageLimits.invite_email_daily_count),
  });
  add({
    group: "collaboration",
    key: "invite_email_recipients_per_batch",
    label: "Invitation recipients per batch",
    value: formatLimitCount(usageLimits.invite_email_recipients_per_batch),
  });
  add({
    group: "collaboration",
    key: "invite_email_pending_per_project",
    label: "Pending invitations per project",
    value: formatLimitCount(usageLimits.invite_email_pending_per_project),
  });
  add({
    group: "collaboration",
    key: "invite_email_pending_per_course",
    label: "Pending invitations per course",
    value: formatLimitCount(usageLimits.invite_email_pending_per_course),
  });
  add({
    group: "collaboration",
    key: "invite_email_resend_cooldown_minutes",
    label: "Invitation resend cooldown",
    value:
      formatCount(usageLimits.invite_email_resend_cooldown_minutes) == null
        ? undefined
        : `${formatCount(
            usageLimits.invite_email_resend_cooldown_minutes,
          )} minutes`,
  });
  add({
    group: "collaboration",
    key: "invite_email_custom_message_max_chars",
    label: "Custom invitation message length",
    value:
      formatCount(usageLimits.invite_email_custom_message_max_chars) == null
        ? undefined
        : `${formatCount(
            usageLimits.invite_email_custom_message_max_chars,
          )} characters`,
  });
  add({
    group: "collaboration",
    key: "invite_email_allow_project_title",
    label: "Project title in invitation email",
    value: formatBoolean(usageLimits.invite_email_allow_project_title),
  });
  add({
    group: "collaboration",
    key: "invite_email_allow_course_title",
    label: "Course title in invitation email",
    value: formatBoolean(usageLimits.invite_email_allow_course_title),
  });
  add({
    group: "collaboration",
    key: "invite_email_allow_urls",
    label: "Custom URLs in invitation email",
    value: formatBoolean(usageLimits.invite_email_allow_urls),
  });
  add({
    group: "collaboration",
    key: "invite_email_link_copy_enabled",
    label: "Copyable invitation links",
    value: formatBoolean(usageLimits.invite_email_link_copy_enabled),
  });

  add({
    group: "images",
    key: "rootfs_count",
    label: "Custom RootFS images",
    value: formatLimitCount(usageLimits.rootfs_count),
  });
  add({
    group: "images",
    key: "rootfs_total_storage_gb",
    label: "Total RootFS storage",
    value: formatGb(usageLimits.rootfs_total_storage_gb),
  });
  add({
    group: "images",
    key: "rootfs_max_storage_gb",
    label: "Storage per RootFS image",
    value: formatGb(usageLimits.rootfs_max_storage_gb),
  });
  add({
    group: "images",
    key: "rootfs_oci_images",
    label: "Remote OCI image import",
    value: formatBoolean(usageLimits.rootfs_oci_images),
  });
  add({
    group: "images",
    key: "blob_account_total_bytes",
    label: "Account blob storage",
    value: formatBytes(usageLimits.blob_account_total_bytes),
  });
  add({
    group: "images",
    key: "blob_account_count",
    label: "Account blob count",
    value: formatLimitCount(usageLimits.blob_account_count),
  });
  add({
    group: "images",
    key: "blob_project_total_bytes",
    label: "Blob storage per project",
    value: formatBytes(usageLimits.blob_project_total_bytes),
  });
  add({
    group: "images",
    key: "blob_project_count",
    label: "Blob count per project",
    value: formatLimitCount(usageLimits.blob_project_count),
  });

  add({
    group: "dedicated-hosts",
    key: "create_hosts",
    label: "Rent dedicated project hosts",
    value: formatBoolean(features.create_hosts),
  });
  add({
    group: "dedicated-hosts",
    key: "dedicated_host_egress_policy",
    label: "Dedicated-host network policy",
    value: formatPolicy(usageLimits.dedicated_host_egress_policy),
  });
  add({
    group: "dedicated-hosts",
    key: "prepaid_host_usage_limit_5h_usd",
    label: "Prepaid host spending guardrail, rolling 5 hours",
    value: formatMoneyLimit(usageLimits.prepaid_host_usage_limit_5h_usd),
  });
  add({
    group: "dedicated-hosts",
    key: "prepaid_host_usage_limit_7d_usd",
    label: "Prepaid host spending guardrail, rolling 7 days",
    value: formatMoneyLimit(usageLimits.prepaid_host_usage_limit_7d_usd),
  });
  add({
    group: "dedicated-hosts",
    key: "credit_spend_limit_5h_usd",
    label: "Postpaid host spending guardrail, rolling 5 hours",
    value: formatMoneyLimit(usageLimits.credit_spend_limit_5h_usd),
  });
  add({
    group: "dedicated-hosts",
    key: "credit_spend_limit_7d_usd",
    label: "Postpaid host spending guardrail, rolling 7 days",
    value: formatMoneyLimit(usageLimits.credit_spend_limit_7d_usd),
  });

  const monthly = asNumber(tier.price_monthly);
  const yearly = asNumber(tier.price_yearly);
  add({
    group: "billing",
    key: "price_monthly",
    label: "Monthly price",
    value: monthly == null ? undefined : currency(monthly),
  });
  add({
    group: "billing",
    key: "price_yearly",
    label: "Annual price",
    value: yearly == null ? undefined : currency(yearly),
  });
  add({
    group: "billing",
    key: "trial_days",
    label: "Free trial",
    value:
      asPositiveInteger(tier.trial_days) == null
        ? undefined
        : `${asPositiveInteger(tier.trial_days)} days`,
  });
  add({
    group: "billing",
    key: "course_price",
    label: "Course membership price",
    value:
      asNumber(tier.course_price) == null
        ? undefined
        : currency(asNumber(tier.course_price)!),
  });
  add({
    group: "billing",
    key: "course_duration_days",
    label: "Course membership duration",
    value:
      asPositiveInteger(tier.course_duration_days) == null
        ? undefined
        : `${asPositiveInteger(tier.course_duration_days)} days`,
  });
  add({
    group: "billing",
    key: "course_grace_days",
    label: "Course grace period",
    value:
      asPositiveInteger(tier.course_grace_days) == null
        ? undefined
        : `${asPositiveInteger(tier.course_grace_days)} days`,
  });

  return (Object.keys(DETAIL_GROUP_TITLES) as DetailGroupKey[])
    .map((key) => ({
      key,
      title: DETAIL_GROUP_TITLES[key],
      details: groups.get(key) ?? [],
    }))
    .filter(({ details }) => details.length > 0);
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
  const detailGroups = buildMembershipTierDetailGroups({
    tier,
    projectDefaults,
    aiLimits,
    features,
    usageLimits,
  });

  const tierLabel = tier.label ?? tier.id;
  const tagline =
    DEFAULT_TAGLINES[tier.id] ??
    `Membership benefits configured for ${tierLabel}.`;

  const sharedHostTier = asNumber(features.project_host_tier);
  if (sharedHostTier != null) {
    const hostPoolBenefit =
      sharedHostTier > 0
        ? `Shared public project-host pool access, tier ${sharedHostTier}.`
        : "Shared public project-host pool access, tier 0.";
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
      if (
        key === "memory_request" &&
        (asNumber(projectDefaults[key]) ?? 0) <= 0
      ) {
        continue;
      }
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
  const cpu5h = asNumber(usageLimits.cpu_5h_seconds);
  if (cpu5h != null && cpu5h > 0) {
    limits.push(`CPU: ${round2(cpu5h / 3600)} CPU-hours per 5 hours`);
  }
  const cpu7d = asNumber(usageLimits.cpu_7d_seconds);
  if (cpu7d != null && cpu7d > 0) {
    limits.push(`CPU: ${round2(cpu7d / 3600)} CPU-hours per 7 days`);
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
    benefits,
    limits,
    billing,
    detailGroups,
  };
}
