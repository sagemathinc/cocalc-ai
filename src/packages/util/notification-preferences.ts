/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY =
  "notification_preferences";
export const OTHER_SETTINGS_NOTIFICATION_PREFERENCES_V2_KEY =
  "notification_preferences_v2";

export type NotificationEmailMode = "immediate" | "digest" | "off" | "none";
export type NotificationEmailSendingMode = "immediate" | "digest";
export type NotificationInAppMode = Exclude<NotificationEmailMode, "none">;

export type NotificationCategory =
  | "billing"
  | "security"
  | "support"
  | "membership_requests"
  | "access_requests"
  | "mentions"
  | "chat_replies"
  | "ai"
  | "onboarding"
  | "product"
  | "maintenance"
  | "course";

export interface NotificationCategoryDefinition {
  key: NotificationCategory;
  label: string;
  description: string;
  defaultEmailMode: NotificationEmailMode;
  requiredEmailMode?: NotificationEmailMode;
  allowedEmailModes?: NotificationEmailMode[];
}

export interface NotificationPreferences {
  version: 1;
  email: Record<NotificationCategory, NotificationEmailMode>;
  digest: {
    time: string;
    timezone: "auto";
  };
}

export type CodexNotificationEventClass =
  | "attention"
  | "completion"
  | "terminal_failure";
export type NotificationEmailStrategy =
  | "off"
  | "immediate"
  | "digest"
  | "unresolved_after_delay";

export interface CodexNotificationChannelPolicy {
  inbox: boolean;
  toast: boolean;
  browser: boolean;
  email: NotificationEmailStrategy;
  email_delay_minutes?: number;
}

export interface NotificationPreferencesV2 {
  version: 2;
  ai: {
    completion_default: boolean;
    events: Record<CodexNotificationEventClass, CodexNotificationChannelPolicy>;
  };
}

const CODEX_EVENT_CLASSES: CodexNotificationEventClass[] = [
  "attention",
  "completion",
  "terminal_failure",
];

export function getDefaultNotificationPreferencesV2(): NotificationPreferencesV2 {
  return {
    version: 2,
    ai: {
      completion_default: true,
      events: {
        attention: {
          inbox: true,
          toast: true,
          browser: true,
          email: "unresolved_after_delay",
          email_delay_minutes: 5,
        },
        completion: {
          inbox: true,
          toast: true,
          browser: true,
          email: "off",
        },
        terminal_failure: {
          inbox: true,
          toast: true,
          browser: true,
          email: "unresolved_after_delay",
          email_delay_minutes: 5,
        },
      },
    },
  };
}

function legacyAiPolicy(
  legacy: NotificationEmailMode,
): Partial<CodexNotificationChannelPolicy> {
  switch (legacy) {
    case "none":
      return { inbox: false, toast: false, browser: false, email: "off" };
    case "immediate":
      return { inbox: true, email: "immediate" };
    case "digest":
      return { inbox: true, email: "digest" };
    default:
      return { inbox: true, email: "off" };
  }
}

function normalizedDelay(
  value: unknown,
  fallback?: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(60, Math.round(value)));
}

function isEmailStrategy(value: unknown): value is NotificationEmailStrategy {
  return (
    value === "off" ||
    value === "immediate" ||
    value === "digest" ||
    value === "unresolved_after_delay"
  );
}

export function normalizeNotificationPreferencesV2(
  rawV2: unknown,
  rawV1?: unknown,
): NotificationPreferencesV2 {
  const defaults = getDefaultNotificationPreferencesV2();
  const legacy = normalizeNotificationPreferences(rawV1);
  const legacyAi = legacyAiPolicy(legacy.email.ai);
  const input =
    rawV2 != null &&
    typeof rawV2 === "object" &&
    typeof (rawV2 as { toJS?: unknown }).toJS === "function"
      ? (rawV2 as { toJS: () => unknown }).toJS()
      : rawV2;
  const rawAi =
    input != null && typeof input === "object" ? (input as any).ai : undefined;
  const explicitV2 = (input as any)?.version === 2 && rawAi != null;
  const events = {} as NotificationPreferencesV2["ai"]["events"];
  for (const eventClass of CODEX_EVENT_CLASSES) {
    const fallback = {
      ...defaults.ai.events[eventClass],
      ...(legacy.email.ai === "none"
        ? legacyAi
        : eventClass === "completion"
          ? legacyAi
          : {}),
    };
    const candidate = explicitV2 ? rawAi?.events?.[eventClass] : undefined;
    events[eventClass] = {
      inbox:
        typeof candidate?.inbox === "boolean"
          ? candidate.inbox
          : fallback.inbox,
      toast:
        typeof candidate?.toast === "boolean"
          ? candidate.toast
          : fallback.toast,
      browser:
        typeof candidate?.browser === "boolean"
          ? candidate.browser
          : fallback.browser,
      email: isEmailStrategy(candidate?.email)
        ? candidate.email
        : fallback.email,
      email_delay_minutes: normalizedDelay(
        candidate?.email_delay_minutes,
        fallback.email_delay_minutes,
      ),
    };
  }
  return {
    version: 2,
    ai: {
      completion_default:
        explicitV2 && typeof rawAi.completion_default === "boolean"
          ? rawAi.completion_default
          : true,
      events,
    },
  };
}

export function codexNotificationEventClass(opts: {
  notice_type?: unknown;
  severity?: unknown;
}): CodexNotificationEventClass | undefined {
  if (opts.notice_type === "codex_attention") return "attention";
  if (opts.notice_type === "codex_turn_completion") {
    return opts.severity === "warning" ? "terminal_failure" : "completion";
  }
  return undefined;
}

export function normalizeCodexCompletionNotificationOverride(
  value: unknown,
  legacy?: { notifyOnTurnFinish?: unknown } | null,
): "inherit" | "on" | "off" {
  if (value === "on" || value === "off" || value === "inherit") return value;
  return legacy?.notifyOnTurnFinish === true ? "on" : "inherit";
}

export function resolveCodexCompletionNotificationEnabled(opts: {
  override: unknown;
  legacy?: { notifyOnTurnFinish?: unknown } | null;
  accountDefault: boolean;
}): boolean {
  const override = normalizeCodexCompletionNotificationOverride(
    opts.override,
    opts.legacy,
  );
  return override === "on"
    ? true
    : override === "off"
      ? false
      : opts.accountDefault;
}

export const NOTIFICATION_EMAIL_MODES: {
  key: NotificationEmailMode;
  label: string;
  description: string;
}[] = [
  {
    key: "immediate",
    label: "Immediate email and in-app",
    description:
      "Send an email soon after this happens and show an in-app notification.",
  },
  {
    key: "digest",
    label: "Digest email and in-app",
    description:
      "Include this in a daily email digest and show an in-app notification.",
  },
  {
    key: "off",
    label: "In-app only",
    description: "Show an in-app notification, but do not send email.",
  },
  {
    key: "none",
    label: "None",
    description: "Do not send email or show an in-app notification.",
  },
];

export const NOTIFICATION_CATEGORIES: NotificationCategoryDefinition[] = [
  {
    key: "security",
    label: "Security",
    description:
      "Password resets, email verification, two-factor authentication, and account access changes.",
    defaultEmailMode: "immediate",
    requiredEmailMode: "immediate",
  },
  {
    key: "billing",
    label: "Billing",
    description:
      "Payments, receipts requiring action, spend limits, and paid resource enforcement.",
    defaultEmailMode: "immediate",
    requiredEmailMode: "immediate",
  },
  {
    key: "membership_requests",
    label: "Membership requests",
    description:
      "Requests, approvals, reverification, and status changes for memberships managed by another account or organization.",
    defaultEmailMode: "immediate",
    allowedEmailModes: ["immediate", "digest"],
  },
  {
    key: "access_requests",
    label: "Access requests",
    description:
      "Requests to access projects and decisions on your access requests.",
    defaultEmailMode: "immediate",
  },
  {
    key: "mentions",
    label: "Mentions",
    description: "Direct mentions in project files and chats.",
    defaultEmailMode: "immediate",
  },
  {
    key: "chat_replies",
    label: "Chat replies",
    description: "Replies in chat threads you follow or have participated in.",
    defaultEmailMode: "immediate",
  },
  {
    key: "ai",
    label: "Codex and agents",
    description: "Long-running AI tasks completed or requiring attention.",
    defaultEmailMode: "off",
  },
  {
    key: "onboarding",
    label: "Project onboarding",
    description:
      "One-time project readiness and first-workflow continuation notices.",
    defaultEmailMode: "immediate",
    allowedEmailModes: ["immediate", "off"],
  },
  {
    key: "course",
    label: "Course",
    description:
      "Course announcements, assignment updates, grading notices, and other course activity.",
    defaultEmailMode: "immediate",
  },
  {
    key: "support",
    label: "Support",
    description:
      "Replies and notices from support staff or site administrators.",
    defaultEmailMode: "immediate",
  },
  {
    key: "maintenance",
    label: "Maintenance",
    description: "Operational notices that may affect access or reliability.",
    defaultEmailMode: "digest",
  },
  {
    key: "product",
    label: "Product news",
    description: "Product updates and feature announcements.",
    defaultEmailMode: "off",
  },
];

const VALID_EMAIL_MODES = new Set<NotificationEmailMode>(
  NOTIFICATION_EMAIL_MODES.map(({ key }) => key),
);

export function getDefaultNotificationPreferences(): NotificationPreferences {
  const email = {} as Record<NotificationCategory, NotificationEmailMode>;
  for (const category of NOTIFICATION_CATEGORIES) {
    email[category.key] =
      category.requiredEmailMode ?? category.defaultEmailMode;
  }
  return {
    version: 1,
    email,
    digest: {
      time: "08:00",
      timezone: "auto",
    },
  };
}

function isNotificationEmailMode(
  value: unknown,
): value is NotificationEmailMode {
  return typeof value === "string" && VALID_EMAIL_MODES.has(value as any);
}

export function notificationModeSendsEmail(
  mode: NotificationEmailMode,
): mode is NotificationEmailSendingMode {
  return mode === "immediate" || mode === "digest";
}

export function notificationModeCreatesInApp(
  mode: NotificationEmailMode,
): mode is NotificationInAppMode {
  return mode !== "none";
}

export function normalizeNotificationPreferences(
  raw: unknown,
): NotificationPreferences {
  const normalizedRaw =
    raw != null &&
    typeof raw === "object" &&
    typeof (raw as { toJS?: unknown }).toJS === "function"
      ? (raw as { toJS: () => unknown }).toJS()
      : raw;
  const defaults = getDefaultNotificationPreferences();
  const rawEmail =
    normalizedRaw != null &&
    typeof normalizedRaw === "object" &&
    (normalizedRaw as { email?: unknown }).email != null &&
    typeof (normalizedRaw as { email?: unknown }).email === "object"
      ? ((normalizedRaw as { email: Record<string, unknown> }).email ?? {})
      : {};
  const legacyCollaborationMode = isNotificationEmailMode(
    rawEmail.collaboration,
  )
    ? rawEmail.collaboration
    : undefined;

  const email = { ...defaults.email };
  for (const category of NOTIFICATION_CATEGORIES) {
    const value =
      rawEmail[category.key] ??
      (category.key === "mentions" || category.key === "chat_replies"
        ? legacyCollaborationMode
        : undefined);
    if (category.requiredEmailMode) {
      email[category.key] = category.requiredEmailMode;
      continue;
    }
    if (
      isNotificationEmailMode(value) &&
      (category.allowedEmailModes == null ||
        category.allowedEmailModes.includes(value))
    ) {
      email[category.key] = value;
      continue;
    }
    email[category.key] = defaults.email[category.key];
  }
  return { ...defaults, email };
}

export function getNotificationCategoryDefinition(
  category: NotificationCategory,
): NotificationCategoryDefinition {
  const definition = NOTIFICATION_CATEGORIES.find(
    ({ key }) => key === category,
  );
  if (!definition) {
    throw Error(`unknown notification category '${category}'`);
  }
  return definition;
}

export const MARKETING_CONSENT_OTHER_SETTINGS_KEY = "newsletter";
export const MARKETING_EMAIL_CONSENT_RECORD_OTHER_SETTINGS_KEY =
  "marketing_email_consent_record";
export const MARKETING_EMAIL_CONSENT_RECORD_VERSION = 1;

export type MarketingEmailConsentSource =
  | "communication-settings"
  | "first-project-open";

export interface MarketingEmailConsentRecord {
  version: typeof MARKETING_EMAIL_CONSENT_RECORD_VERSION;
  enabled: boolean;
  source: MarketingEmailConsentSource;
  recorded_at: string;
}

export function buildMarketingEmailConsentRecord({
  enabled,
  source,
  recordedAt = new Date(),
}: {
  enabled: boolean;
  source: MarketingEmailConsentSource;
  recordedAt?: Date;
}): MarketingEmailConsentRecord {
  return {
    version: MARKETING_EMAIL_CONSENT_RECORD_VERSION,
    enabled,
    source,
    recorded_at: recordedAt.toISOString(),
  };
}

export function setProductMarketingEmailMode(
  raw: unknown,
  enabled: boolean,
): NotificationPreferences {
  const preferences = normalizeNotificationPreferences(raw);
  return {
    ...preferences,
    email: {
      ...preferences.email,
      product: enabled ? "digest" : "off",
    },
  };
}

export function setOnboardingEmailMode(
  raw: unknown,
  enabled: boolean,
): NotificationPreferences {
  const preferences = normalizeNotificationPreferences(raw);
  return {
    ...preferences,
    email: {
      ...preferences.email,
      onboarding: enabled ? "immediate" : "off",
    },
  };
}

export function buildMarketingConsentOtherSettings(
  enabled: boolean,
): Record<string, unknown> {
  return {
    [MARKETING_CONSENT_OTHER_SETTINGS_KEY]: enabled,
    [OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY]: setProductMarketingEmailMode(
      getDefaultNotificationPreferences(),
      enabled,
    ),
  };
}

export function isMarketingConsentEnabled(otherSettings: unknown): boolean {
  return (
    otherSettings != null &&
    typeof otherSettings === "object" &&
    (otherSettings as Record<string, unknown>)[
      MARKETING_CONSENT_OTHER_SETTINGS_KEY
    ] === true
  );
}
