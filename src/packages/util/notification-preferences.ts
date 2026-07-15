/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY =
  "notification_preferences";

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
    label: "AI activity",
    description: "Long-running AI tasks completed or requiring attention.",
    defaultEmailMode: "off",
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
  const defaults = getDefaultNotificationPreferences();
  const rawEmail =
    raw != null &&
    typeof raw === "object" &&
    (raw as { email?: unknown }).email != null &&
    typeof (raw as { email?: unknown }).email === "object"
      ? ((raw as { email: Record<string, unknown> }).email ?? {})
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
