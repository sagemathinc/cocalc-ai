/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import { COLORS } from "@cocalc/util/theme";

export const ESSENTIAL_THEME_STORAGE_KEY = "cocalc-essential-theme";

export type EssentialThemePreference = "system" | "light" | "dark";
export type ResolvedEssentialTheme = "light" | "dark";

export function parseEssentialThemePreference(
  value: string | null | undefined,
): EssentialThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveEssentialTheme(
  preference: EssentialThemePreference,
  systemDark: boolean,
): ResolvedEssentialTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

export const essentialLightTheme = {
  "--ul-accent": COLORS.BLUE_DD,
  "--ul-accent-soft": COLORS.BLUE_LLLL,
  "--ul-bg": COLORS.TOP_BAR.ACTIVE,
  "--ul-border": COLORS.GRAY_LL,
  "--ul-border-dark": COLORS.GRAY_L,
  "--ul-code-bg": COLORS.GRAY_LLL,
  "--ul-code-text": COLORS.GRAY_DD,
  "--ul-danger": COLORS.BS_RED,
  "--ul-danger-soft": COLORS.ANTD_BG_RED_L,
  "--ul-focus": COLORS.YELL_D,
  "--ul-heading": COLORS.GRAY_DD,
  "--ul-ink": COLORS.GRAY_DD,
  "--ul-link": COLORS.BLUE_DD,
  "--ul-muted": COLORS.GRAY_M,
  "--ul-on-accent": COLORS.TOP_BAR.ACTIVE,
  "--ul-output-image-bg": COLORS.TOP_BAR.ACTIVE,
  "--ul-paper": COLORS.TOP_BAR.ACTIVE,
  "--ul-rail": COLORS.GRAY_LLL,
  "--ul-success": COLORS.ANTD_GREEN_D,
  "--ul-topbar": COLORS.BLUE_D,
  "--ul-token-comment": COLORS.GRAY_M,
  "--ul-token-function": COLORS.BLUE_DDD,
  "--ul-token-keyword": COLORS.BS_RED,
  "--ul-token-number": COLORS.BLUE_DD,
  "--ul-token-string": COLORS.ANTD_GREEN_D,
  "--ul-token-warning": COLORS.YELL_D,
  "--ul-terminal-bg": COLORS.TOP_BAR.ACTIVE,
  "--ul-warning": COLORS.YELL_D,
  "--ul-warning-soft": COLORS.YELL_LLL,
} as CSSProperties;

export const essentialDarkTheme = {
  "--ul-accent": COLORS.BLUE_DD,
  "--ul-accent-soft": COLORS.BLUE_DDD,
  "--ul-bg": COLORS.GRAY_DD,
  "--ul-border": COLORS.GRAY_M,
  "--ul-border-dark": COLORS.GRAY,
  "--ul-code-bg": COLORS.GRAY_DD,
  "--ul-code-text": COLORS.GRAY_LL,
  "--ul-danger": COLORS.BS_RED,
  "--ul-danger-soft": `color-mix(in srgb, ${COLORS.BS_RED} 18%, ${COLORS.GRAY_D})`,
  "--ul-focus": COLORS.YELL_L,
  "--ul-heading": COLORS.TOP_BAR.ACTIVE,
  "--ul-ink": COLORS.GRAY_LL,
  "--ul-link": COLORS.BLUE_L,
  "--ul-muted": COLORS.GRAY_L,
  "--ul-on-accent": COLORS.TOP_BAR.ACTIVE,
  "--ul-output-image-bg": COLORS.TOP_BAR.ACTIVE,
  "--ul-paper": COLORS.GRAY_D,
  "--ul-rail": COLORS.GRAY_DD,
  "--ul-success": COLORS.ANTD_GREEN,
  "--ul-topbar": COLORS.BLUE_DDD,
  "--ul-token-comment": COLORS.GRAY_L,
  "--ul-token-function": COLORS.BLUE_L,
  "--ul-token-keyword": COLORS.ANTD_BG_RED_M,
  "--ul-token-number": COLORS.COCALC_ORANGE,
  "--ul-token-string": COLORS.ANTD_GREEN,
  "--ul-token-warning": COLORS.YELL_L,
  "--ul-terminal-bg": COLORS.GRAY_DD,
  "--ul-warning": COLORS.YELL_L,
  "--ul-warning-soft": `color-mix(in srgb, ${COLORS.YELL_D} 22%, ${COLORS.GRAY_D})`,
} as CSSProperties;

export function essentialThemeStyle(
  theme: ResolvedEssentialTheme,
): CSSProperties {
  return {
    ...(theme === "dark" ? essentialDarkTheme : essentialLightTheme),
    colorScheme: theme,
  };
}
