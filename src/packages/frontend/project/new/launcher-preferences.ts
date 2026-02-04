/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { APP_MAP, QUICK_CREATE_MAP } from "./launcher-catalog";

export const LAUNCHER_SETTINGS_KEY = "launcher";

export interface LauncherProjectDefaults {
  quickCreate?: string[];
  apps?: string[];
}

export interface LauncherUserPrefs {
  quickCreate?: string[];
  apps?: string[];
  hiddenQuickCreate?: string[];
  hiddenApps?: string[];
}

export interface LauncherMerged {
  quickCreate: string[];
  apps: string[];
}

export const LAUNCHER_GLOBAL_DEFAULTS: Required<LauncherProjectDefaults> = {
  quickCreate: ["chat", "ipynb", "md", "tex", "term"],
  apps: ["jupyterlab", "code", "jupyter", "pluto", "rserver"],
};

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string");
}

function normalizeObject<T extends object>(value: unknown): Partial<T> {
  if (value == null) return {};
  if (typeof (value as any).toJS === "function") {
    return (value as any).toJS();
  }
  if (typeof value === "object") return value as Partial<T>;
  return {};
}

export function getProjectLauncherDefaults(
  settings: unknown,
): LauncherProjectDefaults {
  const obj = normalizeObject<LauncherProjectDefaults>(settings);
  return {
    quickCreate: normalizeList(obj.quickCreate),
    apps: normalizeList(obj.apps),
  };
}

export function getUserLauncherPrefs(settings: unknown): LauncherUserPrefs {
  const obj = normalizeObject<LauncherUserPrefs>(settings);
  return {
    quickCreate: normalizeList(obj.quickCreate),
    apps: normalizeList(obj.apps),
    hiddenQuickCreate: normalizeList(obj.hiddenQuickCreate),
    hiddenApps: normalizeList(obj.hiddenApps),
  };
}

function filterKnown(list: string[], catalog: Record<string, unknown>): string[] {
  return list.filter((id) => catalog[id] != null);
}

export function mergeLauncherSettings({
  projectDefaults,
  userPrefs,
}: {
  projectDefaults?: LauncherProjectDefaults;
  userPrefs?: LauncherUserPrefs;
}): LauncherMerged {
  const baseQuick =
    projectDefaults?.quickCreate?.length
      ? projectDefaults.quickCreate
      : LAUNCHER_GLOBAL_DEFAULTS.quickCreate;
  const baseApps =
    projectDefaults?.apps?.length
      ? projectDefaults.apps
      : LAUNCHER_GLOBAL_DEFAULTS.apps;

  const userQuick =
    userPrefs?.quickCreate && userPrefs.quickCreate.length > 0
      ? userPrefs.quickCreate
      : baseQuick;
  const userApps =
    userPrefs?.apps && userPrefs.apps.length > 0 ? userPrefs.apps : baseApps;

  const hiddenQuick = userPrefs?.hiddenQuickCreate ?? [];
  const hiddenApps = userPrefs?.hiddenApps ?? [];

  return {
    quickCreate: filterKnown(
      userQuick.filter((id) => !hiddenQuick.includes(id)),
      QUICK_CREATE_MAP,
    ),
    apps: filterKnown(
      userApps.filter((id) => !hiddenApps.includes(id)),
      APP_MAP,
    ),
  };
}

export function buildHiddenList(
  visible: string[],
  catalog: Record<string, unknown>,
): string[] {
  return Object.keys(catalog).filter((id) => !visible.includes(id));
}
