/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Chords use Ctrl on Windows/Linux and Cmd on macOS. Alt+Space and
// Ctrl+Space are taken (window menus, KRunner, CodeMirror autocomplete), and
// Alt+Shift chords switch the input language on Windows.
export const SHORTCUTS = [
  "shift+shift",
  "ctrl+shift+space",
  "ctrl+k",
  "disabled",
] as const;
export type Shortcut = (typeof SHORTCUTS)[number];
export const DEFAULT_DELAY = 400;
export function navigationPreferences(
  settings: { get(key: string): unknown } | undefined,
) {
  const shortcut = settings?.get("quick_navigation_shortcut");
  const delay = settings?.get("quick_navigation_delay");
  return {
    shortcut: SHORTCUTS.includes(shortcut as Shortcut)
      ? (shortcut as Shortcut)
      : ("shift+shift" as Shortcut),
    delay:
      typeof delay === "number" && Number.isFinite(delay)
        ? Math.max(150, Math.min(1000, delay))
        : DEFAULT_DELAY,
  };
}
