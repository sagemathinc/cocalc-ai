/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { CodeLine } from "../code-block/types";
import { SlateElement } from "../register";

export interface JupyterCodeCell extends SlateElement {
  type: "jupyter_code_cell";
  info: string;
  // Stable canonical notebook cell id this element mirrors.
  cell_id?: string;
  // Reserved for projected cell metadata (execution count, tags, etc.).
  cell_meta?: { [key: string]: any };
  // Kept for compatibility with code_block behavior.
  fence?: boolean;
  markdownCandidate?: boolean;
  value?: string;
  children: CodeLine[];
}
