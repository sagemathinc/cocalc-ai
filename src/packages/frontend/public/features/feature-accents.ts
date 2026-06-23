/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { COLORS } from "@cocalc/util/theme";

// Feature-specific accents used when a route needs a stable visual identity
// outside the base public palette.
export const FEATURE_ACCENTS = {
  ai: COLORS.AI_ASSISTANT_FONT,
  automations: "#096dd9",
  julia: "#9558b2",
  octave: COLORS.FG_RED,
  teaching: COLORS.RUN,
} as const;
