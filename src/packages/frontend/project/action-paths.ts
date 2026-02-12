/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { basename, join } from "path";

// Directory destinations in activity logs should be unambiguous.
// Preserve root "/" and avoid introducing duplicate trailing slashes.
export function normalizeDirectoryDestination(dest: string): string {
  if (dest === "/") return "/";
  return dest.endsWith("/") ? dest : `${dest}/`;
}

// Compute the destination path for move operations that target a directory.
export function moveDestinationPath(destDir: string, srcPath: string): string {
  return join(destDir, basename(srcPath));
}
