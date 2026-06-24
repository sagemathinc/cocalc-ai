/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { projectRuntimeHomeRelativePath } from "@cocalc/util/project-runtime";

export function projectRelativeCoursePath(
  path: string | null | undefined,
): string {
  if (!path) return "";
  return projectRuntimeHomeRelativePath(path) ?? path;
}
