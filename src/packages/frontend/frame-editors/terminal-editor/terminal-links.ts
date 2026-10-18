/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Hyperlinks that programs write into terminal output with the OSC 8 escape
// sequence.  Without a linkHandler xterm.js opens them itself, with no check
// of the scheme, so a script URL would run with this page's origin.  Only
// web and mail links are opened, through open_new_tab, and the link text can
// differ from its target, so the user confirms the actual target first.

import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function isOpenableTerminalLink(uri: unknown): boolean {
  if (typeof uri !== "string") {
    return false;
  }
  try {
    return OPENABLE_PROTOCOLS.has(new URL(uri).protocol);
  } catch {
    return false;
  }
}

export function activateTerminalLink(_event: MouseEvent, uri: string): void {
  if (!isOpenableTerminalLink(uri)) {
    console.warn("terminal: not opening a link with an unsupported scheme");
    return;
  }
  if (!window.confirm(`Open this link from the terminal?\n\n${uri}`)) {
    return;
  }
  open_new_tab(uri);
}

export const terminalLinkHandler = { activate: activateTerminalLink };
