/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function shouldBypassWorkspaceStartupGuardForTab(tab?: string): boolean {
  return tab === "files" || tab === "home";
}
