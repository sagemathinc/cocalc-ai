/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

type FontSizeShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "key" | "code"
>;

export function matchFontSizeShortcut(
  event: FontSizeShortcutEvent,
): -1 | 1 | undefined {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) {
    return undefined;
  }
  if (event.key === "<" || event.key === "," || event.code === "Comma") {
    return -1;
  }
  if (event.key === ">" || event.key === "." || event.code === "Period") {
    return 1;
  }
  return undefined;
}
