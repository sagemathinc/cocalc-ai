/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A stable color for something nobody themed, so two threads never look the
// same: the hue comes from its id; light enough not to read as a choice.
export function autoThemeColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `hsl(${hash % 360} 45% 62%)`;
}

// The one color that identifies a thread everywhere it appears (header
// strip, sidebar accent, browser tab): its own theme color if it has one.
export function themeIdentityColor(
  theme: { primaryColor?: string; accentColor?: string },
  seed: string,
): string {
  return theme.primaryColor ?? theme.accentColor ?? autoThemeColor(seed);
}
