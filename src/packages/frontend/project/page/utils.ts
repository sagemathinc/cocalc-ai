/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

interface ModifierKeyEvent {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export function hasModifierKey(e?: ModifierKeyEvent | null) {
  if (e == null) return false;
  return !!(e.ctrlKey || e.shiftKey || e.metaKey);
}

export function shouldOpenFileInNewWindow(e?: ModifierKeyEvent | null) {
  if (e == null) return false;
  return hasModifierKey(e);
}
