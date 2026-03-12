/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalize } from "path";

import { redux } from "@cocalc/frontend/app-framework";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

export type BrowsingPathKey =
  | "explorer_browsing_path_abs"
  | "flyout_browsing_path_abs";

export type BrowsingHistoryKey =
  | "explorer_history_path_abs"
  | "flyout_history_path_abs";

/**
 * Compute the next history path using the same adjacency/nesting rule
 * as `set_current_path`.
 */
export function computeHistoryPath(
  prevHistory: string,
  nextPath: string,
): string {
  const isAdjacent =
    nextPath.length > 0 && !(prevHistory + "/").startsWith(nextPath + "/");
  const isNested = nextPath.length > prevHistory.length;
  return isAdjacent || isNested ? nextPath : prevHistory;
}

export function normalizeBrowsingPath(path: string): string {
  if (path == null || path === "" || path === ".") {
    return "/";
  }
  let normalized = normalize(path);
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (normalized.startsWith(".") && !normalized.startsWith("./")) {
    return normalized;
  }
  return normalizeAbsolutePath(normalized);
}

export function navigateBrowsingPath(
  project_id: string,
  path: string,
  prevHistory: string,
  pathKey: BrowsingPathKey,
  historyKey: BrowsingHistoryKey,
): void {
  const normalizedPath = normalizeBrowsingPath(path);
  const normalizedHistory = normalizeBrowsingPath(
    prevHistory || normalizedPath,
  );
  const nextHistory = computeHistoryPath(normalizedHistory, normalizedPath);
  const actions = redux.getProjectActions(project_id);
  if (actions == null) return;

  const isExplorer = pathKey === "explorer_browsing_path_abs";
  actions.setState({
    [pathKey]: normalizedPath,
    [historyKey]: nextHistory,
    most_recent_file_click: undefined,
    selected_file_index: undefined,
    ...(isExplorer
      ? { new_page_path_abs: normalizedPath }
      : { flyout_new_path_abs: normalizedPath }),
  } as any);

  if (isExplorer) {
    actions.set_url_to_path(normalizedPath, "");
  }
  actions.set_all_files_unchecked();
}
