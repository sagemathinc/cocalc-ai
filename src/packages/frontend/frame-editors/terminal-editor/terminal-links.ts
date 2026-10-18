/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Hyperlinks that programs write into terminal output with the OSC 8 escape
// sequence.  Without a linkHandler xterm.js opens them itself, with no check
// of the scheme beyond xterm's own http/https filter.  This handler keeps
// that allowlist itself, so it holds even if allowNonHttpProtocols is ever
// enabled, opens through open_new_tab (no window.opener), and, since the link
// text can differ from its target, has the user confirm the actual target.

import { open_new_tab } from "@cocalc/frontend/misc/open-browser-tab";

const OPENABLE_PROTOCOLS = new Set(["http:", "https:"]);

// The normalized URL to open, or undefined if this link must not be opened.
export function openableTerminalLink(uri: unknown): string | undefined {
  if (typeof uri !== "string") {
    return undefined;
  }
  try {
    const url = new URL(uri);
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function activateTerminalLink(_event: MouseEvent, uri: string): void {
  const href = openableTerminalLink(uri);
  if (href == null) {
    console.warn("terminal: not opening a link with an unsupported scheme");
    return;
  }
  if (!window.confirm(`Open this link from the terminal?\n\n${href}`)) {
    return;
  }
  open_new_tab(href);
}

export const terminalLinkHandler = { activate: activateTerminalLink };
