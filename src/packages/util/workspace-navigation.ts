/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How the app is navigated: "sidebar" moves account, notification and status
// controls from the top bar into the workspace sidebar; "classic" keeps the
// top bar. Accounts without the setting (created before it existed) are
// classic; new accounts start with the sidebar.
export const WORKSPACE_NAVIGATION_SETTING = "workspace_navigation";
export const NEW_ACCOUNT_WORKSPACE_NAVIGATION = "sidebar";

export type WorkspaceNavigation = "sidebar" | "classic";

export function normalizeWorkspaceNavigation(
  value: unknown,
): WorkspaceNavigation {
  return value === "sidebar" ? "sidebar" : "classic";
}
