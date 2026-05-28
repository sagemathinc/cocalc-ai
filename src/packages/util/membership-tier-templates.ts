import { DEFAULT_QUOTAS } from "@cocalc/util/upgrade-spec";

export const TEMPLATE_PRIORITY = {
  free: 0,
  basic: 10,
  student: 10,
  standard: 20,
  member: 20,
  instructor: 25,
  researcher: 27,
  pro: 30,
} as const;

function quotaTemplate(overrides: Record<string, number>) {
  return { ...DEFAULT_QUOTAS, ...overrides };
}

const MIN_AI_LIMIT = 50;

const STORE_MARKETING = {
  free: {
    store_description:
      "Start using CoCalc with just enough resources to explore the platform and do basic work.",
    store_highlights: [],
  },
  basic: {
    store_description: "For occasional light use.",
    store_highlights: [
      "More shared resources",
      "Access better shared hosts",
      "Modest included AI usage",
    ],
  },
  student: {
    store_description:
      "A term-length membership for students who need course access without a recurring subscription.",
    store_highlights: [
      "One-time course payment",
      "Resources for class projects",
      "Access throughout the academic term",
    ],
  },
  standard: {
    store_description: "A solid choice for everyday work.",
    store_highlights: [
      "Stronger shared resources",
      "Dedicated project host access, including GPU",
      "Larger included AI allowance",
    ],
  },
  instructor: {
    store_description:
      "For instructors managing courses, larger classes, and many collaborators.",
    store_highlights: [
      "Higher project and storage limits",
      "Course-scale invitation limits",
      "More room for teaching workflows",
    ],
  },
  researcher: {
    store_description:
      "For research workflows that need more compute headroom, storage, and custom images.",
    store_highlights: [
      "Higher compute and storage limits",
      "Larger custom RootFS image allowance",
      "Advanced OCI RootFS image import",
    ],
  },
  pro: {
    store_description:
      "For advanced users and teams working on demanding projects.",
    store_highlights: [
      "Best shared resources",
      "Run CoCalc Launchpad wherever you want to stay in full control",
      "Largest included AI allowance",
    ],
  },
} as const;

function usageLimitsTemplate(
  shared_compute_priority: number,
  max_sponsored_running_projects: number,
  overrides: Record<string, number | boolean> = {},
) {
  return {
    shared_compute_priority,
    max_sponsored_running_projects,
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
  activeAutomationsPerProject,
}: {
  queuedPerAccount: number;
  queuedPerThread: number;
  created5hPerAccount: number;
  created7dPerAccount: number;
  runningPerAccount: number;
  runningPerProject: number;
  activeAutomationsPerProject: number;
}) {
  return {
    acp_max_queued_per_account: queuedPerAccount,
    acp_max_queued_per_thread: queuedPerThread,
    acp_max_created_5h_per_account: created5hPerAccount,
    acp_max_created_7d_per_account: created7dPerAccount,
    acp_max_running_per_account: runningPerAccount,
    acp_max_running_per_project: runningPerProject,
    acp_max_active_automations_per_project: activeAutomationsPerProject,
  };
}

function rootfsUsageLimits({
  count,
  totalStorageGb,
  maxStorageGb,
  ociImages,
}: {
  count: number;
  totalStorageGb: number;
  maxStorageGb: number;
  ociImages: boolean;
}) {
  return {
    rootfs_count: count,
    rootfs_total_storage_gb: totalStorageGb,
    rootfs_max_storage_gb: maxStorageGb,
    rootfs_oci_images: ociImages,
  };
}

function blobUsageLimits({
  accountStorageGb,
  accountCount,
  projectStorageGb,
  projectCount,
}: {
  accountStorageGb: number;
  accountCount: number;
  projectStorageGb: number;
  projectCount: number;
}) {
  return {
    blob_account_total_bytes: Math.floor(accountStorageGb * 1_000_000_000),
    blob_account_count: accountCount,
    blob_project_total_bytes: Math.floor(projectStorageGb * 1_000_000_000),
    blob_project_count: projectCount,
  };
}

function inviteUsageLimits({
  sendEnabled,
  dailyCount,
  hourlyCount,
  recipientsPerBatch,
  pendingPerProject,
  pendingPerCourse,
  resendCooldownMinutes,
  customMessageMaxChars,
  allowProjectTitle,
  allowCourseTitle,
  allowUrls,
  linkCopyEnabled = true,
  projectCollaboratorsAndPendingInvites,
  courseStudentsAndPendingInvites,
}: {
  sendEnabled: boolean;
  dailyCount: number;
  hourlyCount: number;
  recipientsPerBatch: number;
  pendingPerProject: number;
  pendingPerCourse: number;
  resendCooldownMinutes: number;
  customMessageMaxChars: number;
  allowProjectTitle: boolean;
  allowCourseTitle: boolean;
  allowUrls: boolean;
  linkCopyEnabled?: boolean;
  projectCollaboratorsAndPendingInvites: number;
  courseStudentsAndPendingInvites: number;
}) {
  return {
    invite_email_send_enabled: sendEnabled,
    invite_email_daily_count: dailyCount,
    invite_email_hourly_count: hourlyCount,
    invite_email_recipients_per_batch: recipientsPerBatch,
    invite_email_pending_per_project: pendingPerProject,
    invite_email_pending_per_course: pendingPerCourse,
    invite_email_resend_cooldown_minutes: resendCooldownMinutes,
    invite_email_custom_message_max_chars: customMessageMaxChars,
    invite_email_allow_project_title: allowProjectTitle,
    invite_email_allow_course_title: allowCourseTitle,
    invite_email_allow_urls: allowUrls,
    invite_email_link_copy_enabled: linkCopyEnabled,
    project_max_collaborators_and_pending_invites:
      projectCollaboratorsAndPendingInvites,
    course_max_students_and_pending_invites: courseStudentsAndPendingInvites,
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
    ...STORE_MARKETING.free,
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
    usage_limits: usageLimitsTemplate(1, 1, {
      ...acpUsageLimits({
        queuedPerAccount: 20,
        queuedPerThread: 5,
        created5hPerAccount: 20,
        created7dPerAccount: 100,
        runningPerAccount: 1,
        runningPerProject: 1,
        activeAutomationsPerProject: 0,
      }),
      ...rootfsUsageLimits({
        count: 0,
        totalStorageGb: 0,
        maxStorageGb: 0,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 0.25,
        accountCount: 200,
        projectStorageGb: 0.25,
        projectCount: 100,
      }),
      ...inviteUsageLimits({
        sendEnabled: false,
        dailyCount: 10,
        hourlyCount: 5,
        recipientsPerBatch: 5,
        pendingPerProject: 10,
        pendingPerCourse: 10,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 300,
        allowProjectTitle: false,
        allowCourseTitle: false,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 10,
        courseStudentsAndPendingInvites: 10,
      }),
    }),
  },
  student: {
    id: "student",
    label: "Student",
    ...STORE_MARKETING.student,
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
    usage_limits: usageLimitsTemplate(2, 3, {
      notification_email_send_limit_5h: 50,
      notification_email_send_limit_7d: 200,
      ...acpUsageLimits({
        queuedPerAccount: 100,
        queuedPerThread: 20,
        created5hPerAccount: 100,
        created7dPerAccount: 500,
        runningPerAccount: 10,
        runningPerProject: 10,
        activeAutomationsPerProject: 3,
      }),
      ...rootfsUsageLimits({
        count: 0,
        totalStorageGb: 0,
        maxStorageGb: 0,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 1,
        accountCount: 1000,
        projectStorageGb: 0.5,
        projectCount: 500,
      }),
      ...inviteUsageLimits({
        sendEnabled: false,
        dailyCount: 20,
        hourlyCount: 10,
        recipientsPerBatch: 10,
        pendingPerProject: 25,
        pendingPerCourse: 50,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 300,
        allowProjectTitle: false,
        allowCourseTitle: false,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 25,
        courseStudentsAndPendingInvites: 50,
      }),
    }),
  },
  basic: {
    id: "basic",
    label: "Basic",
    ...STORE_MARKETING.basic,
    store_visible: false,
    course_store_visible: false,
    price_monthly: 8,
    price_yearly: 9 * 8,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    priority: TEMPLATE_PRIORITY.basic,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 1000,
      mintime: 1800,
      memory: 4000,
      cores: 1,
    }),
    ai_limits: aiLimitsFromYearly(9 * 8),
    features: {
      create_hosts: false,
      project_host_tier: 0,
    },
    usage_limits: usageLimitsTemplate(2, 3, {
      notification_email_send_limit_5h: 50,
      notification_email_send_limit_7d: 200,
      ...acpUsageLimits({
        queuedPerAccount: 100,
        queuedPerThread: 20,
        created5hPerAccount: 100,
        created7dPerAccount: 500,
        runningPerAccount: 10,
        runningPerProject: 10,
        activeAutomationsPerProject: 3,
      }),
      ...rootfsUsageLimits({
        count: 0,
        totalStorageGb: 0,
        maxStorageGb: 0,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 1,
        accountCount: 1000,
        projectStorageGb: 0.5,
        projectCount: 500,
      }),
      ...inviteUsageLimits({
        sendEnabled: false,
        dailyCount: 20,
        hourlyCount: 10,
        recipientsPerBatch: 10,
        pendingPerProject: 25,
        pendingPerCourse: 50,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 300,
        allowProjectTitle: false,
        allowCourseTitle: false,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 25,
        courseStudentsAndPendingInvites: 50,
      }),
    }),
  },
  member: {
    id: "member",
    label: "Member",
    ...STORE_MARKETING.standard,
    store_visible: true,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.member,
    price_monthly: 24,
    price_yearly: 18 * 12,
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
    ai_limits: aiLimitsFromYearly(18 * 12),
    features: {
      create_hosts: true,
      project_host_tier: 1,
    },
    usage_limits: usageLimitsTemplate(3, 3, {
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
        activeAutomationsPerProject: 3,
      }),
      ...rootfsUsageLimits({
        count: 20,
        totalStorageGb: 25,
        maxStorageGb: 10,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 5,
        accountCount: 5000,
        projectStorageGb: 1,
        projectCount: 1000,
      }),
      ...inviteUsageLimits({
        sendEnabled: true,
        dailyCount: 50,
        hourlyCount: 20,
        recipientsPerBatch: 25,
        pendingPerProject: 50,
        pendingPerCourse: 100,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 600,
        allowProjectTitle: true,
        allowCourseTitle: true,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 50,
        courseStudentsAndPendingInvites: 100,
      }),
    }),
  },
  standard: {
    id: "standard",
    label: "Standard",
    ...STORE_MARKETING.standard,
    store_visible: false,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.standard,
    price_monthly: 24,
    price_yearly: 18 * 12,
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
    ai_limits: aiLimitsFromYearly(18 * 12),
    features: {
      create_hosts: true,
      project_host_tier: 1,
    },
    usage_limits: usageLimitsTemplate(3, 3, {
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
        activeAutomationsPerProject: 3,
      }),
      ...rootfsUsageLimits({
        count: 20,
        totalStorageGb: 25,
        maxStorageGb: 10,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 5,
        accountCount: 5000,
        projectStorageGb: 1,
        projectCount: 1000,
      }),
      ...inviteUsageLimits({
        sendEnabled: true,
        dailyCount: 50,
        hourlyCount: 20,
        recipientsPerBatch: 25,
        pendingPerProject: 50,
        pendingPerCourse: 100,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 600,
        allowProjectTitle: true,
        allowCourseTitle: true,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 50,
        courseStudentsAndPendingInvites: 100,
      }),
    }),
  },
  instructor: {
    id: "instructor",
    label: "Instructor",
    ...STORE_MARKETING.instructor,
    store_visible: true,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.instructor,
    price_monthly: 75,
    price_yearly: 75 * 9,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 50000,
      memory: 8000,
      cores: 2,
      mintime: 8 * 3600,
    }),
    ai_limits: aiLimitsFromYearly(75 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 1,
    },
    usage_limits: usageLimitsTemplate(3, 10, {
      max_projects: 250,
      notification_email_send_limit_5h: 500,
      notification_email_send_limit_7d: 2500,
      prepaid_host_usage_limit_5h_usd: 500,
      prepaid_host_usage_limit_7d_usd: 2000,
      ...acpUsageLimits({
        queuedPerAccount: 250,
        queuedPerThread: 50,
        created5hPerAccount: 250,
        created7dPerAccount: 1000,
        runningPerAccount: 25,
        runningPerProject: 10,
        activeAutomationsPerProject: 10,
      }),
      ...rootfsUsageLimits({
        count: 50,
        totalStorageGb: 75,
        maxStorageGb: 20,
        ociImages: false,
      }),
      ...blobUsageLimits({
        accountStorageGb: 15,
        accountCount: 20000,
        projectStorageGb: 2,
        projectCount: 2000,
      }),
      ...inviteUsageLimits({
        sendEnabled: true,
        dailyCount: 500,
        hourlyCount: 200,
        recipientsPerBatch: 200,
        pendingPerProject: 250,
        pendingPerCourse: 500,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 600,
        allowProjectTitle: true,
        allowCourseTitle: true,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 250,
        courseStudentsAndPendingInvites: 500,
      }),
    }),
  },
  researcher: {
    id: "researcher",
    label: "Researcher",
    ...STORE_MARKETING.researcher,
    store_visible: false,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.researcher,
    price_monthly: 100,
    price_yearly: 100 * 9,
    course_price: undefined,
    course_duration_days: undefined,
    course_grace_days: undefined,
    project_defaults: quotaTemplate({
      network: 1,
      member_host: 1,
      disk_quota: 100000,
      memory: 16000,
      cores: 4,
      mintime: 12 * 3600,
    }),
    ai_limits: aiLimitsFromYearly(100 * 9),
    features: {
      create_hosts: true,
      project_host_tier: 2,
    },
    usage_limits: usageLimitsTemplate(4, 15, {
      max_projects: 150,
      notification_email_send_limit_5h: 500,
      notification_email_send_limit_7d: 2500,
      prepaid_host_usage_limit_5h_usd: 750,
      prepaid_host_usage_limit_7d_usd: 2500,
      ...acpUsageLimits({
        queuedPerAccount: 300,
        queuedPerThread: 75,
        created5hPerAccount: 300,
        created7dPerAccount: 1200,
        runningPerAccount: 35,
        runningPerProject: 25,
        activeAutomationsPerProject: 12,
      }),
      ...rootfsUsageLimits({
        count: 100,
        totalStorageGb: 150,
        maxStorageGb: 30,
        ociImages: true,
      }),
      ...blobUsageLimits({
        accountStorageGb: 30,
        accountCount: 50000,
        projectStorageGb: 10,
        projectCount: 5000,
      }),
      ...inviteUsageLimits({
        sendEnabled: true,
        dailyCount: 500,
        hourlyCount: 200,
        recipientsPerBatch: 200,
        pendingPerProject: 250,
        pendingPerCourse: 500,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 800,
        allowProjectTitle: true,
        allowCourseTitle: true,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 250,
        courseStudentsAndPendingInvites: 500,
      }),
    }),
  },
  pro: {
    id: "pro",
    label: "Pro",
    ...STORE_MARKETING.pro,
    store_visible: true,
    course_store_visible: false,
    priority: TEMPLATE_PRIORITY.pro,
    price_monthly: 160,
    price_yearly: 120 * 12,
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
    ai_limits: aiLimitsFromYearly(120 * 12),
    features: {
      create_hosts: true,
      project_host_tier: 2,
    },
    usage_limits: usageLimitsTemplate(4, 10, {
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
        activeAutomationsPerProject: 20,
      }),
      ...rootfsUsageLimits({
        count: 250,
        totalStorageGb: 250,
        maxStorageGb: 30,
        ociImages: true,
      }),
      ...blobUsageLimits({
        accountStorageGb: 25,
        accountCount: 50000,
        projectStorageGb: 5,
        projectCount: 5000,
      }),
      ...inviteUsageLimits({
        sendEnabled: true,
        dailyCount: 1000,
        hourlyCount: 500,
        recipientsPerBatch: 500,
        pendingPerProject: 500,
        pendingPerCourse: 1000,
        resendCooldownMinutes: 15,
        customMessageMaxChars: 1000,
        allowProjectTitle: true,
        allowCourseTitle: true,
        allowUrls: false,
        projectCollaboratorsAndPendingInvites: 500,
        courseStudentsAndPendingInvites: 1000,
      }),
    }),
  },
} as const;

export function getTierTemplate(id: keyof typeof TIER_TEMPLATES) {
  return TIER_TEMPLATES[id];
}

type TierTemplateFields = {
  id?: string;
  label?: string;
  store_visible?: boolean;
  store_description?: string;
  store_highlights?: readonly string[];
  course_store_visible?: boolean;
  course_price?: number;
  course_duration_days?: number;
  course_grace_days?: number;
  priority?: number;
  price_monthly?: number;
  price_yearly?: number;
  trial_days?: number;
  project_defaults?: Record<string, unknown>;
  ai_limits?: Record<string, unknown>;
  features?: Record<string, unknown>;
  usage_limits?: unknown;
};

function mergeTemplateObject(
  templateValue: unknown,
  tierValue: unknown,
): unknown {
  if (
    templateValue != null &&
    typeof templateValue === "object" &&
    !Array.isArray(templateValue) &&
    tierValue != null &&
    typeof tierValue === "object" &&
    !Array.isArray(tierValue)
  ) {
    return {
      ...(templateValue as Record<string, unknown>),
      ...(tierValue as Record<string, unknown>),
    };
  }
  return tierValue ?? templateValue;
}

export function applyMembershipTierTemplateFallbacks<
  T extends TierTemplateFields,
>(tier: T): T {
  const template = TIER_TEMPLATES[tier.id as keyof typeof TIER_TEMPLATES];
  if (template == null) return tier;
  const templateFields = template as TierTemplateFields;
  return {
    ...tier,
    label: tier.label ?? template.label,
    store_visible: tier.store_visible ?? template.store_visible,
    store_description:
      tier.store_description ?? templateFields.store_description,
    store_highlights:
      tier.store_highlights ??
      (templateFields.store_highlights == null
        ? undefined
        : [...templateFields.store_highlights]),
    course_store_visible:
      tier.course_store_visible ?? template.course_store_visible,
    course_price: tier.course_price ?? template.course_price,
    course_duration_days:
      tier.course_duration_days ?? template.course_duration_days,
    course_grace_days: tier.course_grace_days ?? template.course_grace_days,
    priority: tier.priority ?? template.priority,
    price_monthly: tier.price_monthly ?? template.price_monthly,
    price_yearly: tier.price_yearly ?? template.price_yearly,
    trial_days: tier.trial_days ?? templateFields.trial_days,
    project_defaults: mergeTemplateObject(
      template.project_defaults,
      tier.project_defaults,
    ),
    ai_limits: mergeTemplateObject(template.ai_limits, tier.ai_limits),
    features: mergeTemplateObject(template.features, tier.features),
    usage_limits: mergeTemplateObject(template.usage_limits, tier.usage_limits),
  };
}
