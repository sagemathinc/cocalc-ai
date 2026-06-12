/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";

export const PUBLIC_DISPLAY_FONT_FAMILY =
  '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';

export const PUBLIC_COLORS = {
  accent: COLORS.YELL_L,
  accentActive: COLORS.YELL_D,
  brand: COLORS.BLUE_D,
  brandActive: COLORS.BLUE_DD,
  brandDark: COLORS.BLUE_DDD,
  brandSubtle: COLORS.BLUE_LLL,
  brandTint: COLORS.BLUE_LLLL,
  border: COLORS.GRAY_LL,
  footerBackground: COLORS.BLUE_DDD,
  footerHeading: COLORS.YELL_L,
  footerText: COLORS.BLUE_LLL,
  heading: COLORS.BLUE_DDD,
  link: COLORS.BLUE_D,
  linkHover: COLORS.BLUE_DD,
  mutedText: COLORS.GRAY_M,
  pageBackground: COLORS.GRAY_LLL,
  paperBackground: COLORS.GRAY_LLL,
  success: COLORS.RUN,
  surface: COLORS.TOP_BAR.ACTIVE,
  surfaceMuted: COLORS.BLUE_LLLL,
  text: COLORS.GRAY_D,
  warning: COLORS.YELL_D,
  warningBorder: COLORS.YELL_LL,
  warningTint: COLORS.YELL_LLL,
} as const;
