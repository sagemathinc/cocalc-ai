/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Shared "recency" indicator for file listings.

Files that were modified recently get a colored bar on their left edge, which
makes it easy to spot activity in a listing that is sorted by name.  This is
used by the "Files" flyout and by the Explorer file listing, hence this
neutral module – do not move it into either of them.
*/

import {
  green as ANTD_GREEN,
  orange as ANTD_ORANGE,
  yellow as ANTD_YELLOW,
} from "@ant-design/colors";

import type { CSS } from "@cocalc/frontend/app-framework";
import { capitalize, hexColorToRGBA } from "@cocalc/util/misc";
import { server_time } from "@cocalc/util/relative-time";

// width of the colored bar; also used for other borders in the flyouts, such
// that all of them line up
export const FILE_RECENCY_BORDER_WIDTH_PX = "4px";

// fully transparent, i.e. no color at all – but still takes up the same space
export const FILE_RECENCY_COLOR_NONE = "rgba(1, 1, 1, 0)";

/**
 * Color indicating how recently the file was modified: green within the last
 * hour, orange during the last day, and fading yellow up to two weeks.
 * Anything older is transparent.
 *
 * @param time last modification time in milliseconds since the epoch
 */
export function fileRecencyColor(time: number = 0): string {
  const diff = server_time().getTime() - time;
  const days = Math.max(0, diff / 1000 / 60 / 60 / 24);
  if (days < 1 / 24) {
    return hexColorToRGBA(ANTD_GREEN[3], 1);
  } else if (days < 1) {
    const opacity = 1 - days / 2; // only fade to 50%
    return hexColorToRGBA(ANTD_ORANGE[3], opacity);
  } else if (days < 14) {
    const opacity = 1 - (days - 1) / 14;
    return hexColorToRGBA(ANTD_YELLOW[5], opacity);
  }
  return FILE_RECENCY_COLOR_NONE;
}

export function fileItemBorder(
  color: string,
  side: "left" | "top" | "bottom",
): CSS {
  return {
    [`border${capitalize(side)}`]: `${FILE_RECENCY_BORDER_WIDTH_PX} solid ${color}`,
  } as CSS;
}

/**
 * Left border style encoding the recency of the given modification time.
 * Always set, such that the content of all rows lines up.
 *
 * @param time last modification time in milliseconds since the epoch
 */
export function fileRecencyBorder(time: number = 0): CSS {
  return fileItemBorder(fileRecencyColor(time), "left");
}
