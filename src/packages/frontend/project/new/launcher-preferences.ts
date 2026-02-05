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

export interface LauncherUserPrefsStore extends LauncherUserPrefs {
  perProject?: Record<string, LauncherUserPrefs>;
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
  if (value == null) return [];
  if (typeof (value as any).toJS === "function") {
    value = (value as any).toJS();
  } else if (typeof (value as any).toArray === "function") {
    value = (value as any).toArray();
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (typeof value === "object" && value != null) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return [];
    const numericKeys = keys.every((key) => String(Number(key)) === key);
    if (numericKeys) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => obj[key])
        .filter((item) => typeof item === "string") as string[];
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

export function getProjectLauncherDefaults(
  settings: unknown,
): LauncherProjectDefaults {
  const obj = normalizeObject<LauncherProjectDefaults>(settings);
  const quickCreate = normalizeList(obj.quickCreate);
  const apps = normalizeList(obj.apps);
  return {
    quickCreate: quickCreate.length
      ? quickCreate
      : undefined,
    apps: apps.length ? apps : undefined,
  };
}

export function getUserLauncherPrefs(
  settings: unknown,
  project_id?: string,
): LauncherUserPrefs {
  const obj = normalizeObject<LauncherUserPrefsStore>(settings);
  const perProject =
    project_id && obj.perProject && obj.perProject[project_id]
      ? normalizeObject<LauncherUserPrefs>(obj.perProject[project_id])
      : {};
  const baseQuick = normalizeList(obj.quickCreate);
  const baseApps = normalizeList(obj.apps);
  const baseHiddenQuick = normalizeList(obj.hiddenQuickCreate);
  const baseHiddenApps = normalizeList(obj.hiddenApps);
  const perQuick = normalizeList(perProject.quickCreate);
  const perApps = normalizeList(perProject.apps);
  const perHiddenQuick = normalizeList(perProject.hiddenQuickCreate);
  const perHiddenApps = normalizeList(perProject.hiddenApps);
  return {
    quickCreate: perQuick.length ? perQuick : baseQuick,
    apps: perApps.length ? perApps : baseApps,
    hiddenQuickCreate: perHiddenQuick.length ? perHiddenQuick : baseHiddenQuick,
    hiddenApps: perHiddenApps.length ? perHiddenApps : baseHiddenApps,
  };
}

export function updateUserLauncherPrefs(
  settings: unknown,
  project_id: string | undefined,
  prefs: LauncherUserPrefs | null,
): LauncherUserPrefsStore {
  const obj = normalizeObject<LauncherUserPrefsStore>(settings);
  if (!project_id) {
    if (prefs == null) {
      const {
        quickCreate: _quickCreate,
        apps: _apps,
        hiddenQuickCreate: _hiddenQuickCreate,
        hiddenApps: _hiddenApps,
        ...rest
      } = obj;
      return rest as LauncherUserPrefsStore;
    }
    return {
      ...obj,
      quickCreate: prefs.quickCreate ?? [],
      apps: prefs.apps ?? [],
      hiddenQuickCreate: prefs.hiddenQuickCreate ?? [],
      hiddenApps: prefs.hiddenApps ?? [],
    };
  }
  const perProject = {
    ...(obj.perProject ?? {}),
  } as Record<string, LauncherUserPrefs>;
  if (prefs == null) {
    delete perProject[project_id];
  } else {
    perProject[project_id] = prefs;
  }
  return {
    ...obj,
    perProject,
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
