/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { FIXED_PROJECT_TABS } from "./file-tab";
import type { FixedTab } from "./fixed-tab-ids";

export const VIEWER_FIXED_TABS = new Set<FixedTab>([
  "active",
  "docs",
  "files",
  "users",
]);

// Which fixed project tabs a user can open in a project. Shared by the
// activity bar and by Quick Navigation, so navigation never lands on a page
// that renders nothing (for example the image page without a rootfs runtime).
export function filterTabsForProjectAccess({
  agentAIEnabled,
  computeVmEnabled,
  liteMode,
  names,
  rootfsEnabled = true,
  viewer,
}: {
  agentAIEnabled: boolean;
  computeVmEnabled: boolean;
  liteMode: boolean;
  names: readonly FixedTab[];
  rootfsEnabled?: boolean;
  viewer: boolean;
}): FixedTab[] {
  return names.filter((name) => {
    if (!agentAIEnabled && name === "agents") return false;
    if (!computeVmEnabled && name === "vms") return false;
    if (!rootfsEnabled && name === "rootfs") return false;
    if (liteMode && FIXED_PROJECT_TABS[name].noLite) return false;
    if (viewer && !VIEWER_FIXED_TABS.has(name)) return false;
    return true;
  });
}
