/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function defaultOpenProjectTarget({
  target,
  activeProjectTab,
  switchTo = true,
}: {
  target?: string;
  activeProjectTab?: string;
  switchTo?: boolean;
}): string | undefined {
  if (target != null && target !== "") {
    return target;
  }
  if (!switchTo) {
    return undefined;
  }
  if (activeProjectTab == null || activeProjectTab === "files") {
    return "files/";
  }
  return undefined;
}
