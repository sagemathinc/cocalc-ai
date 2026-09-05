/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export type AppearancePreference = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

export const APPEARANCE_STORAGE_KEY = "cocalc-appearance-v1";
export const APPEARANCE_ACCOUNT_STORAGE_KEY = "cocalc-appearance-account-v1";
export const APPEARANCE_SYSTEM_QUERY = "(prefers-color-scheme: dark)";

export function parseAppearancePreference(
  value: unknown,
): AppearancePreference | undefined {
  return value === "system" || value === "light" || value === "dark"
    ? value
    : undefined;
}

export function resolveAppearance(
  preference: AppearancePreference,
  systemDark: boolean,
): ResolvedAppearance {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

// Only call for a loaded account, not the pre-authentication store defaults.
export function accountAppearancePreference(
  settings?: {
    appearance_theme?: unknown;
    dark_mode?: unknown;
  } | null,
): AppearancePreference {
  return (
    parseAppearancePreference(settings?.appearance_theme) ??
    (settings?.dark_mode === true ? "dark" : "light")
  );
}

export interface StoredAppearance {
  version: 1;
  preference: AppearancePreference;
  account_id?: string;
}

export function parseStoredAppearance(
  value: string | null,
): StoredAppearance | undefined {
  try {
    const parsed = JSON.parse(value ?? "null");
    const preference = parseAppearancePreference(parsed?.preference);
    if (parsed?.version !== 1 || preference == null) return;
    if (parsed.account_id != null && typeof parsed.account_id !== "string")
      return;
    return {
      version: 1,
      preference,
      ...(parsed.account_id ? { account_id: parsed.account_id } : {}),
    };
  } catch {
    return;
  }
}

export function serializeAppearance(
  preference: AppearancePreference,
  account_id?: string,
): string {
  return JSON.stringify({
    version: 1,
    preference,
    ...(account_id ? { account_id } : {}),
  });
}

// This readable cookie is a cosmetic cache hint, never proof of authentication.
// Match the site's base path so sibling installations cannot select each other's cache.
export function appearanceAccountCookie(
  cookie: string,
  pathname: string,
): string | undefined {
  let result: string | undefined;
  let matchedLength = -1;
  for (const item of cookie.split(";")) {
    const equals = item.indexOf("=");
    if (equals < 0) continue;
    try {
      const name = decodeURIComponent(item.slice(0, equals).trim());
      if (!name.endsWith("account_id")) continue;
      const base = name.slice(0, -"account_id".length).replace(/\/$/, "");
      if (
        base &&
        (!base.startsWith("/") ||
          (pathname !== base && !pathname.startsWith(`${base}/`)))
      )
        continue;
      if (base.length <= matchedLength) continue;
      result = decodeURIComponent(item.slice(equals + 1));
      matchedLength = base.length;
    } catch {
      // Ignore malformed cookies; appearance must never prevent startup.
    }
  }
  return result || undefined;
}

export interface AppearanceStorageReader {
  getItem(key: string): string | null;
}

export function readStoredAppearance(
  storage: AppearanceStorageReader | undefined,
  accountId?: string,
  legacy?: "essential" | "scratchpad",
): AppearancePreference {
  function read(key: string): string | null {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }
  const account = parseStoredAppearance(read(APPEARANCE_ACCOUNT_STORAGE_KEY));
  if (accountId && account?.account_id === accountId) return account.preference;
  const visitor = parseStoredAppearance(read(APPEARANCE_STORAGE_KEY));
  if (visitor && !visitor.account_id) return visitor.preference;
  if (legacy === "essential") {
    return (
      parseAppearancePreference(read("cocalc-essential-theme")) ?? "system"
    );
  }
  if (legacy === "scratchpad") {
    const old = read("cocalc-scratchpad-dark-mode");
    if (old === "1") return "dark";
    if (old === "0") return "light";
  }
  return "system";
}
