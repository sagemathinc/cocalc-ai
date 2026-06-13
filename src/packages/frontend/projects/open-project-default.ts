/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const FLYOUT_ONLY_PROJECT_TABS = new Set(["active", "users"]);

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
  if (target === "") {
    return "files/";
  }
  if (!switchTo) {
    return undefined;
  }
  if (activeProjectTab == null || activeProjectTab === "files") {
    return "files/";
  }
  if (FLYOUT_ONLY_PROJECT_TABS.has(activeProjectTab)) {
    return "files/";
  }
  return undefined;
}
