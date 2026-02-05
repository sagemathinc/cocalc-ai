/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { APP_MAP } from "./launcher-catalog";

export const LAUNCHER_SETTINGS_KEY = "launcher";

export interface LauncherProjectDefaults {
  quickCreate?: string[];
  apps?: string[];
  hiddenQuickCreate?: string[];
  hiddenApps?: string[];
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
  hiddenQuickCreate: [],
  hiddenApps: [],
};

export const LAUNCHER_SITE_DEFAULTS_QUICK_KEY = "launcher_default_quick_create";
export const LAUNCHER_SITE_DEFAULTS_APPS_KEY = "launcher_default_apps";
export const LAUNCHER_SITE_REMOVE_QUICK_KEY = "launcher_remove_quick_create";
export const LAUNCHER_SITE_REMOVE_APPS_KEY = "launcher_remove_apps";

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
  const hiddenQuickCreate = normalizeList(obj.hiddenQuickCreate);
  const hiddenApps = normalizeList(obj.hiddenApps);
  return {
    quickCreate: quickCreate.length
      ? quickCreate
      : undefined,
    apps: apps.length ? apps : undefined,
    hiddenQuickCreate: hiddenQuickCreate.length ? hiddenQuickCreate : undefined,
    hiddenApps: hiddenApps.length ? hiddenApps : undefined,
  };
}

export function getSiteLauncherDefaults({
  quickCreate,
  apps,
  hiddenQuickCreate,
  hiddenApps,
}: {
  quickCreate?: unknown;
  apps?: unknown;
  hiddenQuickCreate?: unknown;
  hiddenApps?: unknown;
}): LauncherProjectDefaults {
  const normalizedQuickCreate = normalizeList(quickCreate);
  const normalizedApps = normalizeList(apps);
  const normalizedHiddenQuickCreate = normalizeList(hiddenQuickCreate);
  const normalizedHiddenApps = normalizeList(hiddenApps);
  return {
    quickCreate: normalizedQuickCreate.length
      ? normalizedQuickCreate
      : undefined,
    apps: normalizedApps.length ? normalizedApps : undefined,
    hiddenQuickCreate: normalizedHiddenQuickCreate.length
      ? normalizedHiddenQuickCreate
      : undefined,
    hiddenApps: normalizedHiddenApps.length ? normalizedHiddenApps : undefined,
  };
}

export function getUserLauncherLayers(
  settings: unknown,
  project_id?: string,
): {
  account: LauncherUserPrefs;
  project: LauncherUserPrefs;
} {
  const obj = normalizeObject<LauncherUserPrefsStore>(settings);
  const account: LauncherUserPrefs = {
    quickCreate: normalizeList(obj.quickCreate),
    apps: normalizeList(obj.apps),
    hiddenQuickCreate: normalizeList(obj.hiddenQuickCreate),
    hiddenApps: normalizeList(obj.hiddenApps),
  };
  const projectObj =
    project_id && obj.perProject && obj.perProject[project_id]
      ? normalizeObject<LauncherUserPrefs>(obj.perProject[project_id])
      : {};
  const project: LauncherUserPrefs = {
    quickCreate: normalizeList(projectObj.quickCreate),
    apps: normalizeList(projectObj.apps),
    hiddenQuickCreate: normalizeList(projectObj.hiddenQuickCreate),
    hiddenApps: normalizeList(projectObj.hiddenApps),
  };
  return { account, project };
}

export function getUserLauncherPrefs(
  settings: unknown,
  project_id?: string,
): LauncherUserPrefs {
  const { account, project } = getUserLauncherLayers(settings, project_id);
  if (project_id) {
    return {
      quickCreate: project.quickCreate?.length ? project.quickCreate : account.quickCreate,
      apps: project.apps?.length ? project.apps : account.apps,
      hiddenQuickCreate: project.hiddenQuickCreate?.length
        ? project.hiddenQuickCreate
        : account.hiddenQuickCreate,
      hiddenApps: project.hiddenApps?.length ? project.hiddenApps : account.hiddenApps,
    };
  }
  return account;
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

function applyLayer({
  base,
  add,
  remove,
}: {
  base: string[];
  add?: string[];
  remove?: string[];
}): string[] {
  const removed = new Set<string>(uniqNonEmpty(remove ?? []));
  const next = uniqNonEmpty([...(base ?? []), ...(add ?? [])]);
  return next.filter((id) => !removed.has(id));
}

export function mergeLauncherSettings({
  projectDefaults,
  accountUserPrefs,
  projectUserPrefs,
  globalDefaults,
}: {
  projectDefaults?: LauncherProjectDefaults;
  accountUserPrefs?: LauncherUserPrefs;
  projectUserPrefs?: LauncherUserPrefs;
  globalDefaults?: LauncherProjectDefaults;
}): LauncherMerged {
  let quickCreate = uniqNonEmpty(LAUNCHER_GLOBAL_DEFAULTS.quickCreate);
  let apps = uniqNonEmpty(LAUNCHER_GLOBAL_DEFAULTS.apps);

  quickCreate = applyLayer({
    base: quickCreate,
    add: globalDefaults?.quickCreate,
    remove: globalDefaults?.hiddenQuickCreate,
  });
  apps = applyLayer({
    base: apps,
    add: globalDefaults?.apps,
    remove: globalDefaults?.hiddenApps,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: projectDefaults?.quickCreate,
    remove: projectDefaults?.hiddenQuickCreate,
  });
  apps = applyLayer({
    base: apps,
    add: projectDefaults?.apps,
    remove: projectDefaults?.hiddenApps,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: accountUserPrefs?.quickCreate,
    remove: accountUserPrefs?.hiddenQuickCreate,
  });
  apps = applyLayer({
    base: apps,
    add: accountUserPrefs?.apps,
    remove: accountUserPrefs?.hiddenApps,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: projectUserPrefs?.quickCreate,
    remove: projectUserPrefs?.hiddenQuickCreate,
  });
  apps = applyLayer({
    base: apps,
    add: projectUserPrefs?.apps,
    remove: projectUserPrefs?.hiddenApps,
  });

  return {
    quickCreate: quickCreate,
    apps: uniqNonEmpty(filterKnown(apps, APP_MAP)),
  };
}

export function buildHiddenList(
  visible: string[],
  catalog: Record<string, unknown>,
): string[] {
  return Object.keys(catalog).filter((id) => !visible.includes(id));
}
