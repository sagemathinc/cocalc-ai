/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isApplePlatform } from "@cocalc/util/shared-browser-input";

export {
  isAccel,
  keyMessage,
  modifiers,
  nextZoom,
  ZOOMS,
  zoomShortcut,
} from "@cocalc/util/shared-browser-input";

// This device is a Mac, iPhone or iPad (Cmd is the shortcut key).
export function isApple(
  platform: string = (typeof navigator !== "undefined" && navigator.platform) ||
    "",
): boolean {
  return isApplePlatform(platform);
}
