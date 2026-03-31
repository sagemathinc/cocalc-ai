/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const LAUNCHER_SETTINGS_KEY = "launcher";

export interface LauncherProjectDefaults {
  quickCreate?: string[];
  hiddenQuickCreate?: string[];
  quickCreateOrder?: string[];
}

export interface LauncherUserPrefs {
  quickCreate?: string[];
  hiddenQuickCreate?: string[];
  quickCreateOrder?: string[];
}

export interface LauncherUserPrefsStore extends LauncherUserPrefs {
  perProject?: Record<string, LauncherUserPrefs>;
}

export interface LauncherMerged {
  quickCreate: string[];
}

export const LAUNCHER_GLOBAL_DEFAULTS: Required<LauncherProjectDefaults> = {
  quickCreate: ["chat", "ipynb", "md", "tex", "term"],
  hiddenQuickCreate: [],
  quickCreateOrder: [],
};

export const LAUNCHER_SITE_DEFAULTS_QUICK_KEY = "launcher_default_quick_create";
export const LAUNCHER_SITE_REMOVE_QUICK_KEY = "launcher_remove_quick_create";

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
  const hiddenQuickCreate = normalizeList(obj.hiddenQuickCreate);
  const quickCreateOrder = normalizeList(obj.quickCreateOrder);
  return {
    quickCreate: quickCreate.length ? quickCreate : undefined,
    hiddenQuickCreate: hiddenQuickCreate.length ? hiddenQuickCreate : undefined,
    quickCreateOrder: quickCreateOrder.length ? quickCreateOrder : undefined,
  };
}

export function getSiteLauncherDefaults({
  quickCreate,
  hiddenQuickCreate,
}: {
  quickCreate?: unknown;
  hiddenQuickCreate?: unknown;
}): LauncherProjectDefaults {
  const normalizedQuickCreate = normalizeList(quickCreate);
  const normalizedHiddenQuickCreate = normalizeList(hiddenQuickCreate);
  return {
    quickCreate: normalizedQuickCreate.length
      ? normalizedQuickCreate
      : undefined,
    hiddenQuickCreate: normalizedHiddenQuickCreate.length
      ? normalizedHiddenQuickCreate
      : undefined,
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
    hiddenQuickCreate: normalizeList(obj.hiddenQuickCreate),
    quickCreateOrder: normalizeList(obj.quickCreateOrder),
  };
  const projectObj =
    project_id && obj.perProject && obj.perProject[project_id]
      ? normalizeObject<LauncherUserPrefs>(obj.perProject[project_id])
      : {};
  const project: LauncherUserPrefs = {
    quickCreate: normalizeList(projectObj.quickCreate),
    hiddenQuickCreate: normalizeList(projectObj.hiddenQuickCreate),
    quickCreateOrder: normalizeList(projectObj.quickCreateOrder),
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
      quickCreate: project.quickCreate?.length
        ? project.quickCreate
        : account.quickCreate,
      hiddenQuickCreate: project.hiddenQuickCreate?.length
        ? project.hiddenQuickCreate
        : account.hiddenQuickCreate,
      quickCreateOrder: project.quickCreateOrder?.length
        ? project.quickCreateOrder
        : account.quickCreateOrder,
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
  const rest = {
    ...(obj as Record<string, unknown>),
  } as LauncherUserPrefsStore;
  delete (rest as Record<string, unknown>).apps;
  delete (rest as Record<string, unknown>).hiddenApps;
  delete (rest as Record<string, unknown>).appsOrder;
  if (!project_id) {
    if (prefs == null) {
      const {
        quickCreate: _quickCreate,
        hiddenQuickCreate: _hiddenQuickCreate,
        quickCreateOrder: _quickCreateOrder,
      } = rest;
      return rest as LauncherUserPrefsStore;
    }
    return {
      ...rest,
      quickCreate: prefs.quickCreate ?? [],
      hiddenQuickCreate: prefs.hiddenQuickCreate ?? [],
      quickCreateOrder: prefs.quickCreateOrder ?? [],
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
    ...rest,
    perProject,
  };
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

function applyOrder({
  base,
  order,
}: {
  base: string[];
  order?: string[];
}): string[] {
  const normalizedOrder = uniqNonEmpty(order ?? []);
  if (!normalizedOrder.length) return base;
  const prioritized = normalizedOrder.filter((id) => base.includes(id));
  const seen = new Set(prioritized);
  const remainder = base.filter((id) => !seen.has(id));
  return [...prioritized, ...remainder];
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

  quickCreate = applyLayer({
    base: quickCreate,
    add: globalDefaults?.quickCreate,
    remove: globalDefaults?.hiddenQuickCreate,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: projectDefaults?.quickCreate,
    remove: projectDefaults?.hiddenQuickCreate,
  });
  quickCreate = applyOrder({
    base: quickCreate,
    order: projectDefaults?.quickCreateOrder,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: accountUserPrefs?.quickCreate,
    remove: accountUserPrefs?.hiddenQuickCreate,
  });
  quickCreate = applyOrder({
    base: quickCreate,
    order: accountUserPrefs?.quickCreateOrder,
  });
  quickCreate = applyLayer({
    base: quickCreate,
    add: projectUserPrefs?.quickCreate,
    remove: projectUserPrefs?.hiddenQuickCreate,
  });
  quickCreate = applyOrder({
    base: quickCreate,
    order: projectUserPrefs?.quickCreateOrder,
  });

  return {
    quickCreate: quickCreate,
  };
}

export function buildHiddenList(
  visible: string[],
  catalog: Record<string, unknown>,
): string[] {
  return Object.keys(catalog).filter((id) => !visible.includes(id));
}
