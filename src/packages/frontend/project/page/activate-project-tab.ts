/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { FixedTab } from "./fixed-tab-ids";
import {
  getActivityBarPanelMode,
  setActivityBarPanelMode,
} from "./activity-bar-storage";
import {
  shouldForceFixedTabFlyout,
  shouldForceFixedTabFullPage,
} from "./utils";

// Shared by tab clicks and keyboard navigation. Navigation opens a flyout;
// clicking an already-open tab can toggle it closed.
export function activateProjectTab(
  actions: any,
  name: string,
  {
    flyout,
    noFullPage = false,
    event,
    toggle = false,
  }: {
    flyout?: FixedTab;
    noFullPage?: boolean;
    event?: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
    toggle?: boolean;
  } = {},
) {
  if (!flyout) {
    actions.set_active_tab(name);
    return;
  }
  if (shouldForceFixedTabFlyout(event)) {
    setActivityBarPanelMode(flyout, "flyout");
    actions.setFlyoutExpanded(flyout, true);
  } else if (
    !noFullPage &&
    (shouldForceFixedTabFullPage(event) ||
      getActivityBarPanelMode(flyout) !== "flyout")
  ) {
    if (shouldForceFixedTabFullPage(event))
      setActivityBarPanelMode(flyout, "full");
    actions.setFlyoutExpanded(flyout, false, false);
    actions.set_active_tab(name);
  } else {
    setActivityBarPanelMode(flyout, "flyout");
    if (toggle) actions.toggleFlyout(flyout);
    else actions.setFlyoutExpanded(flyout, true);
  }
}
