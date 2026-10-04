/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { avatar_fontcolor } from "@cocalc/frontend/account/avatar/font-color";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

/**
 * How a page header shows its thing's theme, the same for agents and
 * projects: the accent color fills the header (with readable text);
 * otherwise a pale tint of the main color; otherwise the plain surface.
 */
export function headerColors({
  primaryColor,
  accentColor,
}: {
  primaryColor?: string;
  accentColor?: string;
}): { backgroundColor: string; textColor: string } {
  return {
    backgroundColor:
      accentColor ??
      (primaryColor
        ? `color-mix(in srgb, ${primaryColor} 14%, ${UI_COLORS.surface})`
        : UI_COLORS.surface),
    textColor: accentColor ? avatar_fontcolor(accentColor) : UI_COLORS.text,
  };
}
