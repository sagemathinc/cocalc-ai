/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Prefix relative paths with "./" so cp won't parse leading "-" as options.
// Keep absolute paths unchanged.
export function normalizeCpSourcePath(path: string): string {
  if (path.startsWith("/")) {
    return path;
  }
  return path.startsWith("./") ? path : `./${path}`;
}

