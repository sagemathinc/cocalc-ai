/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Node } from "slate";
import type { CodeBlock, CodeLine } from "./types";

export function toCodeLines(value: string): CodeLine[] {
  const lines = value.split("\n");
  if (lines.length === 0) {
    return [{ type: "code_line", children: [{ text: "" }] }];
  }
  return lines.map((line) => ({
    type: "code_line",
    children: [{ text: line }],
  }));
}

export function getCodeBlockText(block: CodeBlock): string {
  if (typeof block.value === "string") {
    return block.value;
  }
  return block.children.map((line) => Node.string(line)).join("\n");
}

export function getCodeBlockLineCount(block: CodeBlock): number {
  return getCodeBlockText(block).split("\n").length;
}

