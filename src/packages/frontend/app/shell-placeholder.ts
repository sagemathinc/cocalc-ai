/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// app.html draws the sidebar as it last looked while the app starts (see
// #cocalc-shell-placeholder there), so arriving from the landing page
// animates into a sidebar instead of a blank page. The workspace saves
// that look and removes the placeholder once the real sidebar is shown.

import { APP_ICON } from "@cocalc/frontend/art";

const KEY = "cocalc-shell-placeholder-v1";

export function saveShellPlaceholder(
  sidebar: HTMLElement | null,
  hidden: boolean,
): void {
  try {
    if (hidden) {
      localStorage.setItem(KEY, JSON.stringify({ hidden: true }));
      return;
    }
    if (sidebar == null || sidebar.offsetWidth === 0) return;
    const style = getComputedStyle(sidebar);
    localStorage.setItem(
      KEY,
      JSON.stringify({
        width: Math.round(sidebar.getBoundingClientRect().width),
        background: style.backgroundColor,
        border: style.borderRightColor,
        color: style.color,
        font: style.fontFamily,
        icon: new URL(APP_ICON, location.href).href,
      }),
    );
  } catch {
    // optional
  }
}

export function removeShellPlaceholder(): void {
  document.getElementById("cocalc-shell-placeholder")?.remove();
}
