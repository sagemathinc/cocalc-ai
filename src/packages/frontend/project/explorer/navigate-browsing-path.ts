/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalize } from "path";

import { redux } from "@cocalc/frontend/app-framework";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";

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
  opts: {
    updateUrl?: boolean;
  } = {},
): void {
  const normalizedPath = normalizeBrowsingPath(path);
  const actions = redux.getProjectActions(project_id);
  if (actions == null) return;

  actions.set_current_path(normalizedPath);
  if (opts.updateUrl) {
    actions.set_url_to_path(normalizedPath, "");
  }
  actions.set_all_files_unchecked();
}
