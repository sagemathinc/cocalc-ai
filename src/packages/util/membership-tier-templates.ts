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

const MIN_LLM_LIMIT = 50;

function llmLimitsFromYearly(price_yearly: number, monthlyOverride?: number) {
  const monthlyCost = monthlyOverride ?? price_yearly / 12;
  const monthlyBudget = monthlyCost * 0.5;
  const units5h = Math.max(
    MIN_LLM_LIMIT,
    Math.round(monthlyBudget * 0.1 * 100),
  );
  const units7d = Math.max(
    MIN_LLM_LIMIT,
    Math.round((monthlyBudget / 2) * 100),
  );
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
    price_monthly: 0,
    price_yearly: 0,
    priority: TEMPLATE_PRIORITY.free,
    project_defaults: quotaTemplate({
      network: 0,
      member_host: 0,
      mintime: 900,
      memory: 2000,
      cores: 0.75,
    }),
    llm_limits: llmLimitsFromYearly(0, 3),
    features: {
      create_hosts: false,
      project_host_tier: 0,
    },
  },
  student: {
    id: "student",
    label: "Student",
    store_visible: false,
    price_monthly: 8,
    price_yearly: 9 * 8,
    priority: TEMPLATE_PRIORITY.student,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      mintime: 1800,
      memory: 4000,
      cores: 1,
    }),
    llm_limits: llmLimitsFromYearly(9 * 8),
    features: {
      create_hosts: false,
      project_host_tier: 0,
    },
  },
  member: {
    id: "member",
    label: "Member",
    store_visible: true,
    priority: TEMPLATE_PRIORITY.member,
    price_monthly: 25,
    price_yearly: 25 * 9,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 10000,
      memory: 8000,
      cores: 2,
      mintime: 3600,
    }),
    llm_limits: llmLimitsFromYearly(25 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 1,
    },
  },
  pro: {
    id: "pro",
    label: "Pro",
    store_visible: true,
    priority: TEMPLATE_PRIORITY.pro,
    price_monthly: 150,
    price_yearly: 150 * 9,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 10000,
      memory: 16000,
      cores: 3,
      mintime: 8 * 3600,
    }),
    llm_limits: llmLimitsFromYearly(150 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 2,
    },
  },
} as const;

export function getTierTemplate(id: keyof typeof TIER_TEMPLATES) {
  return TIER_TEMPLATES[id];
}
