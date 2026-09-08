/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const KNITR_EXTS: ReadonlyArray<string> = ["rnw", "rtex"];

// Icon for word count functionality
export const WORD_COUNT_ICON = "file-alt";

// Whitelist of text file extensions that can be used with \input{} or \include{}
export const ALLOWED_DEP_EXTENSIONS = [
  "bbx",
  "bib",
  "bst",
  "cbx",
  "cfg",
  "cls",
  "def",
  "lbx",
  "md",
  "pgf",
  "rnw",
  "rtex",
  "sty",
  "tex",
  "tikz",
  "txt",
] as const;
