/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import type { FixedTab } from "@cocalc/frontend/project/page/file-tab";

export const APP_DOCS_SELECTED_STORAGE_KEY = "cocalc-app-docs-selected-slug";
export const PROJECT_DOCS_SELECTED_STORAGE_PREFIX =
  "cocalc-project-docs-selected-slug:";
export const PROJECT_DOCS_OPEN_EVENT = "cocalc:project-docs-open";

export type ProjectDocsOpenDetail = {
  projectId: string;
  slug?: string;
};

export function normalizeDocsSlug(slug?: string): string | undefined {
  const normalized = slug
    ?.trim()
    .replace(/^\/+/, "")
    .replace(/^app-docs\/?/, "")
    .replace(/^docs\/?/, "")
    .replace(/^\/+/, "");
  return normalized || undefined;
}

export function projectDocsStorageKey(projectId: string): string {
  return `${PROJECT_DOCS_SELECTED_STORAGE_PREFIX}${projectId}`;
}

export function saveStoredAppDocsSlug(slug?: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDocsSlug(slug);
  if (normalized != null) {
    window.localStorage.setItem(APP_DOCS_SELECTED_STORAGE_KEY, normalized);
  } else {
    window.localStorage.removeItem(APP_DOCS_SELECTED_STORAGE_KEY);
  }
}

export function saveStoredProjectDocsSlug({
  projectId,
  slug,
}: ProjectDocsOpenDetail): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDocsSlug(slug);
  const key = projectDocsStorageKey(projectId);
  if (normalized != null) {
    window.localStorage.setItem(key, normalized);
  } else {
    window.localStorage.removeItem(key);
  }
}

export function openAppDocs(slug?: string): void {
  const normalized = normalizeDocsSlug(slug);
  saveStoredAppDocsSlug(normalized);
  const pageActions = redux.getActions("page");
  pageActions?.setState?.({ docs_print: false, docs_slug: normalized });
  pageActions?.set_active_tab?.("docs", true);
}

export function openProjectDocs({
  projectId,
  slug,
}: ProjectDocsOpenDetail): void {
  const normalized = normalizeDocsSlug(slug);
  saveStoredProjectDocsSlug({ projectId, slug: normalized });
  const pageActions = redux.getActions("page");
  pageActions?.set_active_tab?.(projectId, false);
  const projectActions = redux.getProjectActions(projectId);
  projectActions?.setFlyoutExpanded?.("docs" as FixedTab, true);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<ProjectDocsOpenDetail>(PROJECT_DOCS_OPEN_EVENT, {
        detail: { projectId, slug: normalized },
      }),
    );
  }
}
