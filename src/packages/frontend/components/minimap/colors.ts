/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The whole minimap palette, in one place.

Everything that has a matching token uses `COLORS`.  What is left are values
that a token cannot express: translucent washes that have to let the canvas or
the bars below show through, and the tiny syntax tints the text minimap paints
at ~4px per line, which are a purpose-built rendering palette rather than UI
chrome.  Keeping them here means a theme or dark-mode pass has exactly one file
to touch instead of four.
*/

import { COLORS } from "@cocalc/util/theme";

export const MINIMAP_COLORS = {
  // --- chrome shared by both styles ---
  railBackground: "rgba(255,255,255,0.92)",
  railBorder: COLORS.GRAY_L,
  // the text minimap's viewport rectangle sits over rendered text, so both
  // its outline and its fill are translucent
  viewportBorder: COLORS.BLUE_D,
  viewportFill: "rgba(59,130,246,0.12)",
  // the stylized rectangle sits over bars, and reads better as a neutral frame
  stylizedViewportBorder: COLORS.GRAY_M,
  stylizedViewportFill: "rgba(0,0,0,0.04)",

  // --- block bars ---
  current: COLORS.BLUE_CURRENT,
  block: COLORS.GRAY_L,
  blockQuiet: COLORS.GRAY_L0,
  running: COLORS.BS_GREEN,
  queued: COLORS.BS_GREEN_DD,
  error: COLORS.ANTD_RED,

  // --- canvas ---
  canvasBackground: "rgba(248,250,252,0.96)",
  // row tint of the cell the cursor is in
  canvasCurrentRow: "rgba(59,130,246,0.22)",
  canvasCurrentRowStroke: "rgba(37,99,235,0.8)",
  canvasCurrentLine: "rgba(59,130,246,0.28)",
  // marker for cells that produced output
  canvasOutputMarker: "rgba(245,158,11,0.8)",
} as const;

/**
 * Syntax tints for the text minimap's canvas.  Deliberately more saturated
 * than editor themes: at this size a line is a few pixels tall, so hue is the
 * only thing that survives.
 */
export const MINIMAP_SYNTAX = {
  text: "rgba(15,23,42,0.9)",
  keyword: "rgba(79,70,229,0.96)",
  number: "rgba(37,99,235,0.96)",
  string: "rgba(180,83,9,0.96)",
  comment: "rgba(21,128,61,0.96)",
} as const;

/** Syntax tints as the canvas theme expects them. */
const MINIMAP_SYNTAX_THEME = {
  textColor: MINIMAP_SYNTAX.text,
  keywordColor: MINIMAP_SYNTAX.keyword,
  numberColor: MINIMAP_SYNTAX.number,
  stringColor: MINIMAP_SYNTAX.string,
  commentColor: MINIMAP_SYNTAX.comment,
};

/*
Per-cell-kind tints for the notebook's text minimap: the background wash behind
a cell plus the syntax colors drawn on it.  Markdown leans green and raw leans
purple so cell types stay distinguishable at a glance.
*/
export type MinimapCellKind = "code" | "markdown" | "raw" | "unknown";

export type MinimapCellTheme = {
  cellBackground: string;
  textColor: string;
  keywordColor: string;
  numberColor: string;
  stringColor: string;
  commentColor: string;
};

export const MINIMAP_CELL_THEME: Record<MinimapCellKind, MinimapCellTheme> = {
  code: {
    cellBackground: "rgba(226,232,240,0.78)",
    ...MINIMAP_SYNTAX_THEME,
  },
  markdown: {
    cellBackground: "rgba(220,252,231,0.82)",
    textColor: "rgba(17,24,39,0.9)",
    keywordColor: "rgba(5,150,105,0.96)",
    numberColor: "rgba(4,120,87,0.96)",
    stringColor: MINIMAP_SYNTAX.string,
    commentColor: MINIMAP_SYNTAX.comment,
  },
  raw: {
    cellBackground: "rgba(243,232,255,0.82)",
    textColor: "rgba(30,27,75,0.92)",
    keywordColor: "rgba(109,40,217,0.96)",
    numberColor: "rgba(124,58,237,0.96)",
    stringColor: MINIMAP_SYNTAX.string,
    commentColor: "rgba(126,34,206,0.9)",
  },
  unknown: {
    cellBackground: "rgba(241,245,249,0.82)",
    textColor: "rgba(30,41,59,0.9)",
    keywordColor: "rgba(71,85,105,0.92)",
    numberColor: "rgba(71,85,105,0.92)",
    stringColor: "rgba(71,85,105,0.92)",
    commentColor: "rgba(71,85,105,0.92)",
  },
};
