/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function defaultOpenProjectTarget({
  target,
  activeProjectTab,
}: {
  target?: string;
  activeProjectTab?: string;
}): string | undefined {
  if (target != null && target !== "") {
    return target;
  }
  if (activeProjectTab == null || activeProjectTab === "files") {
    return "home/";
  }
  return undefined;
}
