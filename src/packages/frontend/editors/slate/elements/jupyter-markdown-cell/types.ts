/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { Descendant } from "slate";
import { SlateElement } from "../register";

export interface JupyterMarkdownCell extends SlateElement {
  type: "jupyter_markdown_cell";
  // Stable canonical notebook cell id this element mirrors.
  cell_id?: string;
  // Reserved for projected cell metadata (tags, collapse state, etc.).
  cell_meta?: { [key: string]: any };
  children: Descendant[];
}
