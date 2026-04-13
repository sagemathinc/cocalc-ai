/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";

export function toArchiveRelativePath(
  project_id: string,
  docpath: string,
): string {
  const absolute = normalizeAbsolutePath(
    `${docpath ?? ""}`,
    getProjectHomeDirectory(project_id),
  );
  const runtimeRelative = projectRuntimeHomeRelativePath(absolute);
  if (runtimeRelative != null) {
    return runtimeRelative;
  }
  return absolute.replace(/^\/+/, "");
}
