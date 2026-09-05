/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";
import type { ResolvedAppearance } from "@cocalc/util/appearance";
import { darkAppearance } from "@cocalc/util/appearance-palette";

export const PUBLIC_DISPLAY_FONT_FAMILY =
  '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';

// Warm paper tone from the public-site mock; no matching global COLORS token.
const PUBLIC_PAPER_BACKGROUND = "#fbf8f3";

export const PUBLIC_LIGHT_COLORS = {
  accent: COLORS.YELL_L,
  accentActive: COLORS.YELL_D,
  brand: COLORS.BLUE_D,
  brandActive: COLORS.BLUE_DD,
  brandDark: COLORS.BLUE_DDD,
  brandSubtle: COLORS.BLUE_LLL,
  brandTint: COLORS.BLUE_LLLL,
  border: COLORS.GRAY_LL,
  codeDefinition: "#a61e4d",
  error: COLORS.FG_RED,
  errorBorder: COLORS.ANTD_BG_RED_M,
  errorTint: COLORS.ANTD_BG_RED_L,
  footerBackground: COLORS.BLUE_DDD,
  footerHeading: COLORS.YELL_L,
  footerText: COLORS.BLUE_LLL,
  heading: COLORS.BLUE_DDD,
  info: COLORS.BLUE_DD,
  infoBorder: COLORS.BLUE_LLL,
  infoTint: COLORS.BLUE_LLLL,
  link: COLORS.BLUE_DD,
  linkHover: COLORS.BLUE_DD,
  mutedText: COLORS.GRAY_M,
  pageBackground: PUBLIC_PAPER_BACKGROUND,
  paperBackground: PUBLIC_PAPER_BACKGROUND,
  primary: COLORS.BLUE_DD,
  onPrimary: COLORS.WHITE,
  heroBackground: COLORS.BLUE_DD,
  shadowInk: COLORS.BLUE_DDD,
  success: COLORS.RUN,
  successBorder: COLORS.BS_GREEN,
  successTint: COLORS.BS_GREEN_LL,
  surface: COLORS.TOP_BAR.ACTIVE,
  surfaceMuted: COLORS.BLUE_LLLL,
  text: COLORS.GRAY_D,
  warning: COLORS.YELL_D,
  warningBorder: COLORS.YELL_LL,
  warningTint: COLORS.YELL_LLL,
} as const;

type PublicColorKey = keyof typeof PUBLIC_LIGHT_COLORS;
export type PublicColors = Record<PublicColorKey, string>;

export const PUBLIC_DARK_COLORS: PublicColors = {
  ...PUBLIC_LIGHT_COLORS,
  brand: darkAppearance.link,
  brandActive: darkAppearance.link,
  brandSubtle: darkAppearance.controlBorder,
  brandTint: darkAppearance.infoBg,
  border: darkAppearance.border,
  codeDefinition: darkAppearance.keyword,
  error: darkAppearance.danger,
  errorBorder: darkAppearance.danger,
  errorTint: darkAppearance.dangerBg,
  heading: darkAppearance.text,
  info: darkAppearance.info,
  infoBorder: darkAppearance.info,
  infoTint: darkAppearance.infoBg,
  link: darkAppearance.link,
  linkHover: darkAppearance.linkHover,
  mutedText: darkAppearance.secondary,
  pageBackground: darkAppearance.page,
  paperBackground: darkAppearance.page,
  primary: darkAppearance.primary,
  shadowInk: "#000000",
  surface: darkAppearance.surface,
  surfaceMuted: darkAppearance.inset,
  text: darkAppearance.text,
  success: darkAppearance.success,
  successBorder: darkAppearance.success,
  successTint: darkAppearance.successBg,
  warning: darkAppearance.warning,
  warningBorder: darkAppearance.warning,
  warningTint: darkAppearance.warningBg,
};

export function getPublicColors(mode: ResolvedAppearance): PublicColors {
  return mode === "dark" ? PUBLIC_DARK_COLORS : PUBLIC_LIGHT_COLORS;
}

// DOM styles stay reactive without rebuilding every feature/demo component.
// Consumers that calculate colors (notably ConfigProvider) use getPublicColors.
export const PUBLIC_COLORS = Object.fromEntries(
  Object.keys(PUBLIC_LIGHT_COLORS).map((key) => [
    key,
    `var(--cocalc-public-${key})`,
  ]),
) as PublicColors;

function publicDeclarations(colors: PublicColors): string {
  return Object.entries(colors)
    .map(([key, value]) => `--cocalc-public-${key}:${value}`)
    .join(";");
}

// Small icons and feature accents are UI, unlike the fixed artwork below.
// Preserve each light identity while giving it a readable dark counterpart.
const ACCENT_PAIRS = [
  [COLORS.ANTD_LINK_BLUE_DARK, darkAppearance.link],
  [COLORS.BLUE_D, darkAppearance.link],
  [COLORS.BLUE_DD, darkAppearance.link],
  [COLORS.FEATURE_BLUE, darkAppearance.link],
  [COLORS.FEATURE_R_BLUE, darkAppearance.link],
  [COLORS.FEATURE_OCTAVE_BLUE, darkAppearance.link],
  [COLORS.AI_ASSISTANT_FONT, darkAppearance.warning],
  [COLORS.YELL_D, darkAppearance.warning],
  [COLORS.BG_WARNING, darkAppearance.warning],
  [COLORS.FEATURE_ORANGE, darkAppearance.number],
  ["#d46b08", darkAppearance.number],
  [COLORS.RUN, darkAppearance.success],
  [COLORS.FG_RED, darkAppearance.danger],
  [COLORS.FEATURE_RED, darkAppearance.danger],
  [COLORS.FEATURE_JULIA_PURPLE, darkAppearance.keyword],
  [COLORS.FEATURE_PURPLE, darkAppearance.keyword],
  [COLORS.FEATURE_TEAL, darkAppearance.string],
] as const;

export function publicAccent(color: string): string {
  const index = ACCENT_PAIRS.findIndex(([light]) => light === color);
  return index < 0 ? color : `var(--cocalc-public-accent-${index})`;
}

function accentDeclarations(mode: ResolvedAppearance): string {
  return ACCENT_PAIRS.map(
    ([light, dark], index) =>
      `--cocalc-public-accent-${index}:${mode === "dark" ? dark : light}`,
  ).join(";");
}

export const PUBLIC_THEME_CSS = `
:root{${publicDeclarations(PUBLIC_LIGHT_COLORS)};${accentDeclarations("light")}}
:root[data-cocalc-theme="dark"]{${publicDeclarations(PUBLIC_DARK_COLORS)};${accentDeclarations("dark")}}
@media(prefers-color-scheme:dark){:root:not([data-cocalc-theme]){${publicDeclarations(PUBLIC_DARK_COLORS)};${accentDeclarations("dark")}}}
@media print{:root,:root[data-cocalc-theme="dark"]{${publicDeclarations(PUBLIC_LIGHT_COLORS)};${accentDeclarations("light")}}}
`;

// ── Design-system tokens (D1, Tier A) ────────────────────────────────────────
// Codify the latent system the home page already embodies so the whole public
// site is consistent. These are INERT until pages consume them (no visual change
// on add). Reuse existing values only — no rebrand, no new hues.

// Single hex/white → rgba helper. Hoisted from home/app.tsx so the duplicate
// copies (home/app, features/app, features/compare-page, features/teaching-page)
// import one source instead of redefining it.
export function alpha(hexColor: string, opacity: number): string {
  if (hexColor.startsWith("var(")) {
    return `color-mix(in srgb, ${hexColor} ${Math.max(0, Math.min(1, opacity)) * 100}%, transparent)`;
  }
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

// Public type scale — codifies the dominant inline text sizes already in use
// (lead 18 is the home + site default at 19 uses; strays 17/19 snap to it, 15 →
// 16, 20 → 18). Headings render via antd <Title> levels; these tokens are for
// inline eyebrow / caption / body / lead / subhead / panel-title text. The home
// hero's display sizes (30 / 58) stay home-only. Feature/product pages converge
// onto these so a paragraph is never an ad-hoc px value again.
export const PUBLIC_TYPE = {
  eyebrow: 12,
  caption: 13,
  body: 16,
  lead: 18,
  subhead: 22,
  title: 24,
} as const;

// Two text weights across the public site (a stray 800 snaps to bold).
export const PUBLIC_WEIGHT = {
  medium: 600,
  bold: 700,
} as const;

// One elevation ink. Derived from the home page's existing shadow values (it
// uses alpha(brandDark)), so home stays pixel-identical while feature pages —
// which currently use a parallel slate rgba(33,49,57) ink — converge onto these.
const ELEVATION_INK = PUBLIC_COLORS.shadowInk;
export const PUBLIC_ELEVATION = {
  sm: `0 10px 30px ${alpha(ELEVATION_INK, 0.05)}`,
  md: `0 18px 44px ${alpha(ELEVATION_INK, 0.07)}`,
  lg: `0 24px 70px ${alpha(ELEVATION_INK, 0.12)}`,
  hover: `0 18px 44px ${alpha(ELEVATION_INK, 0.1)}`,
  compact: `0 10px 24px ${alpha(ELEVATION_INK, 0.07)}`,
  card: `0 12px 30px ${alpha(ELEVATION_INK, 0.08)}`,
  code: `0 12px 34px ${alpha(ELEVATION_INK, 0.07)}`,
  media: `0 14px 40px ${alpha(ELEVATION_INK, 0.07)}`,
  panel: `0 18px 52px ${alpha(ELEVATION_INK, 0.08)}`,
  panelStrong: `0 18px 52px ${alpha(ELEVATION_INK, 0.12)}`,
} as const;

// Fixed artwork palette for terminal/code/editor/notebook mock chrome. These
// demos retain their authored colors independently of the page appearance.
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
