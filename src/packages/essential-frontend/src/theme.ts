/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { CSSProperties } from "react";
import {
  parseAppearancePreference,
  resolveAppearance,
  type AppearancePreference,
  type ResolvedAppearance,
} from "@cocalc/util/appearance";

export const ESSENTIAL_THEME_STORAGE_KEY = "cocalc-essential-theme";

export type EssentialThemePreference = AppearancePreference;
export type ResolvedEssentialTheme = ResolvedAppearance;

export function parseEssentialThemePreference(
  value: string | null | undefined,
): EssentialThemePreference {
  return parseAppearancePreference(value) ?? "system";
}

export function resolveEssentialTheme(
  preference: EssentialThemePreference,
  systemDark: boolean,
): ResolvedEssentialTheme {
  return resolveAppearance(preference, systemDark);
}

export function essentialThemeStyle(
  theme: ResolvedEssentialTheme,
): CSSProperties {
  return { colorScheme: theme };
}
