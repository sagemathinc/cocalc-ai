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

// ── Design-system tokens (D1, Tier A) ────────────────────────────────────────
// Codify the latent system the home page already embodies so the whole public
// site is consistent. These are INERT until pages consume them (no visual change
// on add). Reuse existing values only — no rebrand, no new hues.

// Single hex/white → rgba helper. Hoisted from home/app.tsx so the duplicate
// copies (home/app, features/app, features/compare-page, features/teaching-page)
// import one source instead of redefining it.
export function alpha(hexColor: string, opacity: number): string {
  if (hexColor === COLORS.TOP_BAR.ACTIVE) {
    return `rgba(255, 255, 255, ${opacity})`;
  }
  const hex = hexColor.replace("#", "");
  if (hex.length !== 6) return hexColor;
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

// 8px panel radius is already canonical (~132 uses); media is the larger corner
// for big imagery/code boxes. Strays (10/14/16) snap to these.
export const PUBLIC_RADIUS = {
  panel: 8,
  media: 12,
  pill: 999,
} as const;

// One elevation ink. Derived from the home page's existing shadow values (it
// uses alpha(brandDark)), so home stays pixel-identical while feature pages —
// which currently use a parallel slate rgba(33,49,57) ink — converge onto these.
const ELEVATION_INK = PUBLIC_COLORS.brandDark;
export const PUBLIC_ELEVATION = {
  sm: `0 10px 30px ${alpha(ELEVATION_INK, 0.05)}`,
  md: `0 18px 44px ${alpha(ELEVATION_INK, 0.07)}`,
  lg: `0 24px 70px ${alpha(ELEVATION_INK, 0.12)}`,
  hover: `0 18px 44px ${alpha(ELEVATION_INK, 0.1)}`,
} as const;

// Dark is reserved EXCLUSIVELY for terminal/code/editor/notebook mock chrome.
// Single source the DARK_FEATURE_CARD_STYLE test derives from, so adding a mock
// surface updates token + guard together. (deepSurface #0b1f47 is the jupyter
// agent-CLI panel, previously an unnamed literal.)
export const PUBLIC_DARK = {
  terminalSurface: "#0b1522",
  codeSurface: "#10213f",
  deepSurface: "#0b1f47",
  barSurface: "#111827",
  mockText: "#dbeafe",
  mockTextAlt: "#86efac",
  mockTextDim: "#bfdbfe",
  dotRed: "#ff6b6b",
  dotAmber: "#ffd166",
  dotGreen: "#06d6a0",
} as const;
