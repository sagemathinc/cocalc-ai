/*
 *  This file is part of CoCalc: Copyright © 2023 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CSS, useMemo } from "@cocalc/frontend/app-framework";
import { DirectoryListingEntry } from "@cocalc/frontend/project/explorer/types";
import { capitalize, getRandomColor } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";
import { BORDER_WIDTH_PX } from "./consts";
import { FlyoutActiveMode, FlyoutLogDeduplicate, FlyoutLogMode } from "./state";

export const FLYOUT_LOG_DEFAULT_MODE: FlyoutLogMode = "files";

export const FLYOUT_ACTIVE_DEFAULT_MODE: FlyoutActiveMode = "tabs";

export const FLYOUT_LOG_DEFAULT_DEDUP: FlyoutLogDeduplicate = true;

export const FLYOUT_LOG_FILTER_MODES = [
  "open",
  "files",
  "project",
  "user",
  "other",
] as const;
export type FlyoutLogFilter = (typeof FLYOUT_LOG_FILTER_MODES)[number];

// by default, we show all events except for the file openings
// they are in the separate "files" tab
export const FLYOUT_LOG_FILTER_DEFAULT = FLYOUT_LOG_FILTER_MODES.filter(
  (x) => x !== "open",
) as Readonly<FlyoutLogFilter[]>;

export const GROUP_STYLE: CSS = {
  fontWeight: "bold",
  marginTop: "5px",
} as const;

export function deterministicColor(group: string) {
  return group === ""
    ? COLORS.GRAY_L
    : getRandomColor(group, { diff: 30, min: 185, max: 245 });
}

export function randomBorder(group: string, side: "left" | "bottom"): CSS {
  const col = deterministicColor(group);
  return fileItemBorder(col, side);
}

export function useSingleFile({
  checked_files,
  activeFile,
  getFile,
  directoryFiles,
}): DirectoryListingEntry | undefined {
  return useMemo(() => {
    if (checked_files.size === 0 && activeFile != null) {
      return activeFile;
    }
    if (checked_files.size === 1) {
      return getFile(checked_files.first() ?? "");
    }
  }, [checked_files, directoryFiles, activeFile]);
}

export function fileItemStyle(_time: number = 0, masked: boolean = false): CSS {
  return masked ? { color: COLORS.FILE_DIMMED } : {};
}

export function fileItemBorder(color: string, side: "left" | "top" | "bottom") {
  return {
    [`border${capitalize(side)}`]: `${BORDER_WIDTH_PX} solid ${color}`,
  } as CSS;
}
