/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Icon + accent color per feature page, keyed by slug. Kept in this tiny
module (instead of app.tsx) so the public top nav can render the
Features dropdown with icons without importing the lazily-loaded
features app chunk.
*/

import { type IconName } from "@cocalc/frontend/components/icon";
import { PUBLIC_COLORS, publicAccent } from "@cocalc/frontend/public/theme";
import { COLORS } from "@cocalc/util/theme";

import { FEATURE_ACCENTS } from "./feature-accents";

const FEATURE_META = {
  ai: { accent: FEATURE_ACCENTS.ai, icon: "robot" },
  api: { accent: COLORS.ANTD_LINK_BLUE_DARK, icon: "api" },
  compare: { accent: COLORS.BLUE_D, icon: "swap" },
  "exam-scratchpads": {
    accent: COLORS.RUN,
    icon: "graduation-cap",
  },
  "jupyter-notebook": {
    accent: COLORS.BLUE_D,
    icon: "jupyter",
  },
  julia: { accent: FEATURE_ACCENTS.julia, icon: "julia" },
  "latex-editor": { accent: COLORS.YELL_D, icon: "tex" },
  linux: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "linux",
  },
  octave: { accent: COLORS.FG_RED, icon: "octave" },
  python: { accent: COLORS.BLUE_D, icon: "python" },
  "r-statistical-software": {
    accent: COLORS.BLUE_DD,
    icon: "r",
  },
  sage: { accent: COLORS.RUN, icon: "sagemath" },
  slides: { accent: COLORS.BG_WARNING, icon: "slides" },
  "software-environment": {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "server",
  },
  teaching: { accent: FEATURE_ACCENTS.teaching, icon: "graduation-cap" },
  terminal: {
    accent: COLORS.ANTD_LINK_BLUE_DARK,
    icon: "terminal",
  },
  whiteboard: { accent: COLORS.FG_RED, icon: "layout" },
  x11: {
    accent: COLORS.RUN,
    icon: "window-restore",
  },
} satisfies Record<string, { accent: string; icon: IconName }>;

export function featureMeta(slug: string): { accent: string; icon: IconName } {
  const meta = FEATURE_META[slug as keyof typeof FEATURE_META] ?? {
    accent: PUBLIC_COLORS.brand,
    icon: "star",
  };
  return { ...meta, accent: publicAccent(meta.accent) };
}
