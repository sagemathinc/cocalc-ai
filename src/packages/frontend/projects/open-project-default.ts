/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function defaultOpenProjectTarget({
  target,
  activeProjectTab,
  hasOpenFiles,
}: {
  target?: string;
  activeProjectTab?: string;
  hasOpenFiles: boolean;
}): string | undefined {
  if (target != null) {
    return target;
  }
  if (!hasOpenFiles && activeProjectTab === "files") {
    return "home/";
  }
  return undefined;
}

