/*
 *  This file is part of CoCalc: Copyright © 2025 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Settings and preferences type definitions shared across packages.
 * These are used by both frontend and backend (e.g., in next.js pages).
 */

// Preferences sub-tab types
export const VALID_PREFERENCES_SUB_TYPES = [
  "appearance",
  "editor",
  "keyboard",
  "ai",
  "communication",
  "keys",
  "other",
] as const;

export type PreferencesSubTabType =
  (typeof VALID_PREFERENCES_SUB_TYPES)[number];

export type PreferencesSubTabKey = `preferences-${PreferencesSubTabType}`;

export const VALID_LICENSES_SUB_TYPES = [
  "team-licenses",
  "site-licenses",
  "software-licenses",
] as const;

export type LicensesSubTabType = (typeof VALID_LICENSES_SUB_TYPES)[number];

export const VALID_BILLING_SUB_TYPES = [
  "subscriptions",
  "balance",
  "purchases",
  "payments",
  "payment-methods",
  "statements",
] as const;

export type BillingSubTabType = (typeof VALID_BILLING_SUB_TYPES)[number];

// Valid leaf settings pages. Menu/URL grouping is intentionally not part of
// page identity, so callers can open a page without knowing where it lives.
export const VALID_SETTINGS_PAGES = [
  "index",
  "profile",
  "membership",
  "usage-limits",
  ...VALID_LICENSES_SUB_TYPES,
  ...VALID_PREFERENCES_SUB_TYPES,
  ...VALID_BILLING_SUB_TYPES,
  "support",
] as const;

export type SettingsPageType = (typeof VALID_SETTINGS_PAGES)[number];

// Navigation path type combining all valid paths
export type NavigatePath =
  | "settings"
  | "settings/index"
  | `settings/${Exclude<SettingsPageType, "index">}`;
