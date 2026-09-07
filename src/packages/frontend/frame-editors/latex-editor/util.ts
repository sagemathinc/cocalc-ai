/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// data and functions specific to the latex editor.

import { separate_file_extension } from "@cocalc/util/misc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { TITLE_BAR_BORDER } from "../frame-tree/style";

export const OUTPUT_HEADER_STYLE = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "10px",
  borderBottom: TITLE_BAR_BORDER,
  backgroundColor: UI_COLORS.surface,
  color: UI_COLORS.text,
  flexShrink: 0,
} as const;

export function pdf_path(path: string): string {
  // if it is already a pdf, don't change the upper/lower casing -- #4562
  const { name, ext } = separate_file_extension(path);
  if (ext.toLowerCase() == "pdf") return path;
  return `${name}.pdf`;
}
