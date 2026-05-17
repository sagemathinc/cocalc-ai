/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

export const LAUNCHER_SETTINGS_KEY = "launcher";

export interface LauncherPrefs {
  quickCreate?: string[];
}

export interface LauncherMerged {
  quickCreate: string[];
}

export const LAUNCHER_GLOBAL_DEFAULTS: Required<LauncherPrefs> = {
  quickCreate: ["chat", "ipynb", "md", "tex", "term"],
};

export const LAUNCHER_SITE_DEFAULTS_QUICK_KEY = "launcher_default_quick_create";

// Temporary legacy export while callers are migrated off site remove lists.
export const LAUNCHER_SITE_REMOVE_QUICK_KEY = "launcher_remove_quick_create";

function normalizeList(value: unknown): string[] {
  if (value == null) return [];
  if (typeof (value as any).toJS === "function") {
    value = (value as any).toJS();
  } else if (typeof (value as any).toArray === "function") {
    value = (value as any).toArray();
  }
  if (Array.isArray(value)) {
    return uniqNonEmpty(value.filter((item) => typeof item === "string"));
  }
  if (typeof value === "object" && value != null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return [];
    const numericKeys = keys.every((key) => String(Number(key)) === key);
    if (numericKeys) {
      return uniqNonEmpty(
        keys
          .sort((a, b) => Number(a) - Number(b))
          .map((key) => obj[key])
          .filter((item) => typeof item === "string") as string[],
      );
    }
  }
  return [];
}

function normalizeObject<T extends object>(value: unknown): Partial<T> {
  if (value == null) return {};
  if (typeof (value as any).toJS === "function") {
    return (value as any).toJS();
  }
  if (typeof value === "object") return value as Partial<T>;
  return {};
}

function uniqNonEmpty(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const id = `${raw ?? ""}`.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function normalizeQuickCreate(value: unknown): string[] {
  return normalizeList(value);
}

export function getSiteLauncherDefaults(quickCreate: unknown): LauncherPrefs {
  const source =
    typeof quickCreate === "object" &&
    quickCreate != null &&
    !Array.isArray(quickCreate)
      ? (quickCreate as { quickCreate?: unknown }).quickCreate
      : quickCreate;
  const normalized = normalizeQuickCreate(source);
  return {
    quickCreate: normalized.length ? normalized : undefined,
  };
}

export function getAccountLauncherPrefs(settings: unknown): LauncherPrefs {
  const obj = normalizeObject<LauncherPrefs>(settings);
  const quickCreate = normalizeQuickCreate(obj.quickCreate);
  return {
    quickCreate: quickCreate.length ? quickCreate : undefined,
  };
}

export function updateAccountLauncherPrefs(
  settings: unknown,
  prefs: LauncherPrefs | null,
): LauncherPrefs {
  const obj = normalizeObject<Record<string, unknown>>(settings);
  const rest = { ...obj };
  delete rest.apps;
  delete rest.hiddenApps;
  delete rest.appsOrder;
  delete rest.hiddenQuickCreate;
  delete rest.quickCreateOrder;
  delete rest.perProject;
  if (prefs == null) {
    delete rest.quickCreate;
    return rest as LauncherPrefs;
  }
  return {
    ...rest,
    quickCreate: normalizeQuickCreate(prefs.quickCreate),
  };
}

export function getEffectiveLauncher({
  accountPrefs,
  siteDefaults,
}: {
  accountPrefs?: LauncherPrefs;
  siteDefaults?: LauncherPrefs;
}): LauncherMerged {
  const accountQuick = normalizeQuickCreate(accountPrefs?.quickCreate);
  if (accountQuick.length) {
    return { quickCreate: accountQuick };
  }
  const siteQuick = normalizeQuickCreate(siteDefaults?.quickCreate);
  if (siteQuick.length) {
    return { quickCreate: siteQuick };
  }
  return { quickCreate: LAUNCHER_GLOBAL_DEFAULTS.quickCreate };
}

// Temporary compatibility exports while the old project/per-project callers are
// removed. These intentionally ignore project layers so every caller sees the
// same exact site/account model during the transition.
export type LauncherProjectDefaults = LauncherPrefs;
export type LauncherUserPrefs = LauncherPrefs;
export interface LauncherUserPrefsStore extends LauncherPrefs {}

export function getProjectLauncherDefaults(_settings: unknown): LauncherPrefs {
  return {};
}

export function getUserLauncherLayers(settings: unknown): {
  account: LauncherPrefs;
  project: LauncherPrefs;
} {
  return {
    account: getAccountLauncherPrefs(settings),
    project: {},
  };
}

export function getUserLauncherPrefs(settings: unknown): LauncherPrefs {
  return getAccountLauncherPrefs(settings);
}

export function updateUserLauncherPrefs(
  settings: unknown,
  _project_id: string | undefined,
  prefs: LauncherPrefs | null,
): LauncherPrefs {
  return updateAccountLauncherPrefs(settings, prefs);
}

export function mergeLauncherSettings({
  accountUserPrefs,
  globalDefaults,
}: {
  projectDefaults?: LauncherPrefs;
  accountUserPrefs?: LauncherPrefs;
  projectUserPrefs?: LauncherPrefs;
  globalDefaults?: LauncherPrefs;
}): LauncherMerged {
  return getEffectiveLauncher({
    accountPrefs: accountUserPrefs,
    siteDefaults: globalDefaults,
  });
}
