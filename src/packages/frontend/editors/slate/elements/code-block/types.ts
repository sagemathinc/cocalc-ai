/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Descendant } from "slate";
import { SlateElement } from "../register";

export interface CodeLine extends SlateElement {
  type: "code_line";
  children: Descendant[];
}

export interface CodeBlock extends SlateElement {
  type: "code_block";
  fence: boolean;
  info: string;
  markdownCandidate?: boolean;
  // Legacy field from the old CodeMirror-based code block.
  value?: string;
  children: CodeLine[];
}

