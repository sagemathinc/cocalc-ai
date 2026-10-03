/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { message } from "antd";

const SEEN_KEY = "cocalc:sidebar-hidden-hint";

// The first time someone hides the sidebar, say how to get it back: a
// hidden sidebar stays hidden across reloads.
export function explainHiddenSidebarOnce(): void {
  try {
    if (localStorage.getItem(SEEN_KEY)) return;
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    return;
  }
  void message.info({
    content:
      "Sidebar hidden. Click the CoCalc logo at the top left, or press Ctrl/Cmd+Shift+P, to show it again.",
    duration: 8,
  });
}
