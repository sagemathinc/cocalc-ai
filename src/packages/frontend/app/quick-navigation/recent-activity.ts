/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import {
  get_local_storage,
  set_local_storage,
} from "@cocalc/frontend/misc/local-storage";
import { tab_to_path } from "@cocalc/util/misc";

// Which files this browser actually worked in, most recent last. Nothing in
// the stores records tab activation order (the project log only records
// opens), so Quick Navigation keeps its own small history in localStorage.
const KEY = "quick-navigation-recent";
const MAX = 200;
export type Activity = { [projectId: string]: { [path: string]: number } };
let cache: Activity | undefined;
let last: string | undefined;

export function recentActivity(): Activity {
  if (cache == null) {
    cache = {};
    try {
      const raw = get_local_storage(KEY);
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (parsed && typeof parsed === "object") cache = parsed as Activity;
    } catch {
      cache = {};
    }
  }
  return cache;
}

export function noteActivity(
  projectId: string,
  path: string,
  now = Date.now(),
): void {
  const key = `${projectId}\n${path}`;
  if (key === last) return;
  last = key;
  const activity = recentActivity();
  (activity[projectId] ??= {})[path] = now;
  const entries: [string, string, number][] = [];
  for (const [project, paths] of Object.entries(activity))
    for (const [file, time] of Object.entries(paths))
      entries.push([project, file, time]);
  if (entries.length > MAX) {
    entries.sort((a, b) => a[2] - b[2]);
    for (const [project, file] of entries.slice(0, entries.length - MAX)) {
      delete activity[project][file];
      if (!Object.keys(activity[project]).length) delete activity[project];
    }
  }
  set_local_storage(KEY, JSON.stringify(activity));
}

export function resetRecentActivityForTests(): void {
  cache = undefined;
  last = undefined;
}

// Record the active editor tab of the foreground project whenever it changes.
export function trackRecentActivity(): () => void {
  const page = redux.getStore("page");
  const projects = redux.getStore("projects");
  if (page == null) return () => {};
  const subscribed = new Map<string, () => void>();
  const note = (projectId: string) => {
    if (page.get("active_top_tab") !== projectId) return;
    if (!redux.hasProjectStore(projectId)) return;
    const path = tab_to_path(
      redux.getProjectStore(projectId).get("active_project_tab"),
    );
    if (path) noteActivity(projectId, path);
  };
  const reconcile = () => {
    const open: string[] = projects?.get("open_projects")?.toArray?.() ?? [];
    for (const id of open) {
      if (subscribed.has(id) || !redux.hasProjectStore(id)) continue;
      const store = redux.getProjectStore(id);
      const changed = () => note(id);
      store.on("change", changed);
      subscribed.set(id, () => store.removeListener("change", changed));
    }
    for (const [id, off] of subscribed)
      if (!open.includes(id)) {
        off();
        subscribed.delete(id);
      }
    const active = page.get("active_top_tab");
    if (typeof active === "string") note(active);
  };
  page.on("change", reconcile);
  projects?.on("change", reconcile);
  reconcile();
  return () => {
    page.removeListener("change", reconcile);
    projects?.removeListener("change", reconcile);
    for (const off of subscribed.values()) off();
    subscribed.clear();
  };
}
