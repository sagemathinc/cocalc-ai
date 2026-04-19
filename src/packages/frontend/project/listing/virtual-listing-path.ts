/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isSnapshotsPath } from "@cocalc/util/consts/snapshots";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

export function resolveVirtualListingPath({
  path,
  homePath,
}: {
  path: string;
  homePath: string;
}): string {
  if (isSnapshotsPath(path)) {
    const resolvedHomePath =
      homePath && homePath !== "/" ? homePath : DEFAULT_PROJECT_RUNTIME_HOME;
    return normalizeAbsolutePath(path.replace(/^\/+/, ""), resolvedHomePath);
  }
  return path;
}
