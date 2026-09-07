/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { ResolvedAppearance } from "./appearance";

export const FOLLOW_APPEARANCE = "follow-appearance";
export const FOLLOW_APPEARANCE_LABEL = "Follow application appearance";

// Only the explicit follow setting is dynamic. Missing and historical defaults
// must not silently replace a user's existing editor or terminal palette.
export function resolveAppearanceEditorTheme<
  T extends string | null | undefined,
>(theme: T, appearance: ResolvedAppearance): T | string {
  return theme === FOLLOW_APPEARANCE ? `cocalc-${appearance}` : theme;
}
