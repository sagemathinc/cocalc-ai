/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { COLORS } from "./theme";
import type { ResolvedAppearance } from "./appearance";

// Semantic UI colors, separate from the literal COLORS used for authored content.
export const lightAppearance = {
  page: COLORS.WHITE,
  surface: COLORS.WHITE,
  elevated: COLORS.WHITE,
  inset: COLORS.GRAY_LLL,
  text: COLORS.GRAY_DD,
  buttonText: "#000000e0",
  secondary: COLORS.GRAY_M,
  muted: "#686868",
  disabled: "#767676",
  border: "#d4d4d4",
  controlBorder: "#858585",
  hover: "#edf1f5",
  selected: COLORS.BLUE_LLLL,
  link: COLORS.BLUE_DD,
  linkHover: COLORS.BLUE_DDD,
  visited: "#7042a1",
  focus: COLORS.BLUE_DD,
  primary: COLORS.BLUE_DD,
  onPrimary: COLORS.WHITE,
  success: "#23713b",
  successBg: "#f6ffed",
  warning: "#805400",
  warningBg: "#fff5d6",
  danger: "#b32329",
  dangerBg: "#fff0f0",
  info: COLORS.BLUE_DD,
  infoBg: COLORS.BLUE_LLLL,
  codeBg: "#f3f4f5",
  codeText: COLORS.GRAY_DD,
  comment: "#62676e",
  keyword: "#98417e",
  string: "#246b36",
  number: "#92500e",
  function: COLORS.BLUE_DD,
  scrim: "rgba(0,0,0,0.4)",
  shadow: "rgba(0,0,0,0.14)",
};

export const darkAppearance: AppearancePalette = {
  page: "#191b1e",
  surface: "#222529",
  elevated: "#2b2e33",
  inset: "#1c1e22",
  text: "#e6e8eb",
  buttonText: "#e6e8eb",
  secondary: "#b9bfc7",
  muted: "#a4adb8",
  disabled: "#979fa9",
  border: "#474d56",
  controlBorder: "#858e9b",
  hover: "#333941",
  selected: "#253e59",
  link: "#9cc5ff",
  linkHover: "#c4ddff",
  visited: "#d4b1f7",
  focus: "#fbb635",
  primary: "#3465a9",
  onPrimary: COLORS.WHITE,
  success: "#8bd3a0",
  successBg: "#20382a",
  warning: "#f0ca78",
  warningBg: "#3b321f",
  danger: "#ffa5a5",
  dangerBg: "#40272b",
  info: "#9cc5ff",
  infoBg: "#25364d",
  codeBg: "#1c1e22",
  codeText: "#e6e8eb",
  comment: "#a4adb8",
  keyword: "#e8afe0",
  string: "#9ed4a9",
  number: "#edbf91",
  function: "#9cc5ff",
  scrim: "rgba(0,0,0,0.65)",
  shadow: "rgba(0,0,0,0.35)",
};

export type AppearanceToken = keyof typeof lightAppearance;
export type AppearancePalette = Record<AppearanceToken, string>;

export function appearancePalette(mode: ResolvedAppearance): AppearancePalette {
  return mode === "dark" ? darkAppearance : lightAppearance;
}

export function appearanceVariable(name: AppearanceToken): string {
  return `var(--cocalc-ui-${name})`;
}

export const UI_COLORS = Object.fromEntries(
  Object.keys(lightAppearance).map((key) => [
    key,
    appearanceVariable(key as AppearanceToken),
  ]),
) as Record<AppearanceToken, string>;

function declarations(palette: AppearancePalette): string {
  return Object.entries(palette)
    .map(([key, value]) => `--cocalc-ui-${key}:${value}`)
    .join(";");
}

// Shared by generated entry HTML and standalone readers; no runtime CSS generator.
export function appearanceStyleSheet(): string {
  return `
:root{${declarations(lightAppearance)};color-scheme:light}
:root[data-cocalc-theme="dark"]{${declarations(darkAppearance)};color-scheme:dark}
@media(prefers-color-scheme:dark){:root:not([data-cocalc-theme]){${declarations(darkAppearance)};color-scheme:dark}}
html,body{background:var(--cocalc-ui-page);color:var(--cocalc-ui-text)}
@media print{:root,:root[data-cocalc-theme="dark"]{${declarations(lightAppearance)};color-scheme:light}html,body{background:white;color:black}}
`;
}
