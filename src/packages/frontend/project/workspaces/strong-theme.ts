/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { WorkspaceRecord } from "./types";
import { hexColorToRGBA } from "@cocalc/util/misc";
import { COLORS } from "@cocalc/util/theme";

export type WorkspaceStrongThemeChrome = {
  primary: string;
  accent: string;
  activityBarBackground: string;
  activityBarBorder: string;
  frameTopBorder: string;
  frameRightBorder: string;
  frameBottomBorder: string;
};

function alpha(color: string, opacity: number): string {
  const trimmed = `${color ?? ""}`.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return hexColorToRGBA(trimmed, opacity);
  }
  return trimmed;
}

export function workspaceStrongThemeChrome(
  record?: Pick<WorkspaceRecord, "strong_theme" | "theme"> | null,
): WorkspaceStrongThemeChrome | null {
  if (record?.strong_theme !== true) return null;
  const primary =
    record.theme.color ?? record.theme.accent_color ?? COLORS.BLUE_D;
  const accent =
    record.theme.accent_color ?? record.theme.color ?? COLORS.ANTD_GREEN_D;
  return {
    primary,
    accent,
    activityBarBackground: `linear-gradient(180deg, ${alpha(
      accent,
      0.12,
    )} 0%, ${alpha(primary, 0.06)} 100%)`,
    activityBarBorder: accent,
    frameTopBorder: `3px solid ${primary}`,
    frameRightBorder: `3px solid ${alpha(accent, 0.78)}`,
    frameBottomBorder: `4px solid ${accent}`,
  };
}
