/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const OTHER_SETTINGS_NOTIFICATION_PREFERENCES_KEY =
  "notification_preferences";

export type NotificationEmailMode = "immediate" | "digest" | "off";

export type NotificationCategory =
  | "billing"
  | "security"
  | "support"
  | "collaboration"
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
    label: "Immediate",
    description: "Email me soon after this notification happens.",
  },
  {
    key: "digest",
    label: "Daily digest",
    description: "Include this in one daily summary email.",
  },
  {
    key: "off",
    label: "CoCalc only",
    description: "Show this in CoCalc, but do not email me.",
  },
];

export const NOTIFICATION_CATEGORIES: NotificationCategoryDefinition[] = [
  {
    key: "billing",
    label: "Billing and spend",
    description:
      "Payments, receipts requiring action, spend limits, and dedicated-host enforcement.",
    defaultEmailMode: "immediate",
    requiredEmailMode: "immediate",
  },
  {
    key: "security",
    label: "Security and access",
    description:
      "Password resets, email verification, 2FA, and account access changes.",
    defaultEmailMode: "immediate",
    requiredEmailMode: "immediate",
  },
  {
    key: "support",
    label: "Support and admin",
    description: "Support replies and account notices from CoCalc staff.",
    defaultEmailMode: "immediate",
  },
  {
    key: "collaboration",
    label: "Mentions and collaboration",
    description:
      "Mentions, project invitations, and direct collaboration notifications.",
    defaultEmailMode: "immediate",
  },
  {
    key: "ai",
    label: "AI and Codex",
    description: "Long-running AI or Codex work completed.",
    defaultEmailMode: "off",
  },
  {
    key: "product",
    label: "Product news",
    description: "Product updates and announcements.",
    defaultEmailMode: "digest",
  },
  {
    key: "maintenance",
    label: "Maintenance",
    description: "Operational notices that may affect access or reliability.",
    defaultEmailMode: "digest",
  },
  {
    key: "course",
    label: "Course announcements",
    description:
      "Instructor announcements and future course broadcast messages.",
    defaultEmailMode: "immediate",
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

  const email = { ...defaults.email };
  for (const category of NOTIFICATION_CATEGORIES) {
    const value = rawEmail[category.key];
    email[category.key] = category.requiredEmailMode
      ? category.requiredEmailMode
      : isNotificationEmailMode(value)
        ? value
        : defaults.email[category.key];
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
