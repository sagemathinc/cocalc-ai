import { DEFAULT_QUOTAS } from "@cocalc/util/upgrade-spec";

export const TEMPLATE_PRIORITY = {
  free: 0,
  student: 10,
  member: 20,
  pro: 30,
} as const;

function quotaTemplate(overrides: Record<string, number>) {
  return { ...DEFAULT_QUOTAS, ...overrides };
}

const MIN_AI_LIMIT = 50;

function usageLimitsTemplate(
  shared_compute_priority: number,
  overrides: Record<string, number> = {},
) {
  return {
    shared_compute_priority,
    notification_email_send_limit_5h: 10,
    notification_email_send_limit_7d: 40,
    ...overrides,
  };
}

function acpUsageLimits({
  queuedPerAccount,
  queuedPerThread,
  created5hPerAccount,
  created7dPerAccount,
  runningPerAccount,
  runningPerProject,
}: {
  queuedPerAccount: number;
  queuedPerThread: number;
  created5hPerAccount: number;
  created7dPerAccount: number;
  runningPerAccount: number;
  runningPerProject: number;
}) {
  return {
    acp_max_queued_per_account: queuedPerAccount,
    acp_max_queued_per_thread: queuedPerThread,
    acp_max_created_5h_per_account: created5hPerAccount,
    acp_max_created_7d_per_account: created7dPerAccount,
    acp_max_running_per_account: runningPerAccount,
    acp_max_running_per_project: runningPerProject,
  };
}

function aiLimitsFromYearly(price_yearly: number, monthlyOverride?: number) {
  const monthlyCost = monthlyOverride ?? price_yearly / 12;
  const monthlyBudget = monthlyCost * 0.5;
  const units5h = Math.max(MIN_AI_LIMIT, Math.round(monthlyBudget * 0.1 * 100));
  const units7d = Math.max(MIN_AI_LIMIT, Math.round((monthlyBudget / 2) * 100));
  return {
    units_5h: units5h,
    units_7d: units7d,
  };
}

export const TIER_TEMPLATES = {
  free: {
    id: "free",
    label: "Free",
    store_visible: false,
    course_store_visible: false,
    price_monthly: 0,
    price_yearly: 0,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    priority: TEMPLATE_PRIORITY.free,
    project_defaults: quotaTemplate({
      network: 0,
      member_host: 0,
      mintime: 900,
      memory: 2000,
      cores: 0.75,
    }),
    ai_limits: aiLimitsFromYearly(0, 3),
    features: {
      create_hosts: false,
      project_host_tier: 0,
    },
    usage_limits: usageLimitsTemplate(1, {
      ...acpUsageLimits({
        queuedPerAccount: 20,
        queuedPerThread: 5,
        created5hPerAccount: 20,
        created7dPerAccount: 100,
        runningPerAccount: 1,
        runningPerProject: 1,
      }),
    }),
  },
  student: {
    id: "student",
    label: "Student",
    store_visible: false,
    course_store_visible: true,
    price_monthly: 8,
    price_yearly: 9 * 8,
    course_price: 25,
    course_duration_days: 122,
    course_grace_days: 14,
    priority: TEMPLATE_PRIORITY.student,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      mintime: 1800,
      memory: 4000,
      cores: 1,
    }),
    ai_limits: aiLimitsFromYearly(9 * 8),
    features: {
      create_hosts: false,
      project_host_tier: 0,
    },
    usage_limits: usageLimitsTemplate(2, {
      notification_email_send_limit_5h: 50,
      notification_email_send_limit_7d: 200,
      ...acpUsageLimits({
        queuedPerAccount: 100,
        queuedPerThread: 20,
        created5hPerAccount: 100,
        created7dPerAccount: 500,
        runningPerAccount: 10,
        runningPerProject: 10,
      }),
    }),
  },
  member: {
    id: "member",
    label: "Member",
    store_visible: true,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.member,
    price_monthly: 25,
    price_yearly: 25 * 9,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 10000,
      memory: 8000,
      cores: 2,
      mintime: 3600,
    }),
    ai_limits: aiLimitsFromYearly(25 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 1,
    },
    usage_limits: usageLimitsTemplate(3, {
      notification_email_send_limit_5h: 200,
      notification_email_send_limit_7d: 1000,
      prepaid_host_usage_limit_5h_usd: 300,
      prepaid_host_usage_limit_7d_usd: 1000,
      ...acpUsageLimits({
        queuedPerAccount: 100,
        queuedPerThread: 20,
        created5hPerAccount: 100,
        created7dPerAccount: 500,
        runningPerAccount: 10,
        runningPerProject: 10,
      }),
    }),
  },
  pro: {
    id: "pro",
    label: "Pro",
    store_visible: true,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.pro,
    price_monthly: 150,
    price_yearly: 150 * 9,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 10000,
      memory: 16000,
      cores: 3,
      mintime: 8 * 3600,
    }),
    ai_limits: aiLimitsFromYearly(150 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 2,
    },
    usage_limits: usageLimitsTemplate(4, {
      notification_email_send_limit_5h: 1000,
      notification_email_send_limit_7d: 5000,
      credit_spend_limit_5h_usd: 300,
      credit_spend_limit_7d_usd: 1000,
      prepaid_host_usage_limit_5h_usd: 1000,
      prepaid_host_usage_limit_7d_usd: 3000,
      ...acpUsageLimits({
        queuedPerAccount: 500,
        queuedPerThread: 100,
        created5hPerAccount: 500,
        created7dPerAccount: 2000,
        runningPerAccount: 50,
        runningPerProject: 50,
      }),
    }),
  },
} as const;

export function getTierTemplate(id: keyof typeof TIER_TEMPLATES) {
  return TIER_TEMPLATES[id];
}

type TierTemplateFields = {
  id?: string;
  course_store_visible?: boolean;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: unknown;
};

export function applyMembershipTierTemplateFallbacks<
  T extends TierTemplateFields,
>(tier: T): T {
  const template = TIER_TEMPLATES[tier.id as keyof typeof TIER_TEMPLATES];
  if (template == null) return tier;
  return {
    ...tier,
    course_store_visible:
      tier.course_store_visible ?? template.course_store_visible,
    course_price: tier.course_price ?? template.course_price,
    course_duration_days:
      tier.course_duration_days ?? template.course_duration_days,
    course_grace_days: tier.course_grace_days ?? template.course_grace_days,
    project_defaults: tier.project_defaults ?? template.project_defaults,
    ai_limits: tier.ai_limits ?? template.ai_limits,
    features: tier.features ?? template.features,
    usage_limits:
      tier.usage_limits != null &&
      typeof tier.usage_limits === "object" &&
      !Array.isArray(tier.usage_limits)
        ? {
            ...(template.usage_limits ?? {}),
            ...(tier.usage_limits as Record<string, unknown>),
          }
        : (tier.usage_limits ?? template.usage_limits),
  };
}
