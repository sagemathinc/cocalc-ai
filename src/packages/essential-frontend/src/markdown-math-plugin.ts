/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type MarkdownIt from "markdown-it";

type InlineState = {
  pos: number;
  src: string;
  push: (
    type: string,
    tag: string,
    nesting: number,
  ) => {
    content: string;
    markup: string;
  };
};

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findClosing(source: string, marker: string, from: number): number {
  let index = source.indexOf(marker, from);
  while (index >= 0 && isEscaped(source, index)) {
    index = source.indexOf(marker, index + marker.length);
  }
  return index;
}

function inlineMath(marker: "$" | "$$" | "\\(" | "\\[") {
  const closing = marker === "\\(" ? "\\)" : marker === "\\[" ? "\\]" : marker;
  const display = marker === "$$" || marker === "\\[";
  return (state: InlineState, silent: boolean): boolean => {
    const start = state.pos;
    if (!state.src.startsWith(marker, start) || isEscaped(state.src, start)) {
      return false;
    }
    if (marker === "$" && state.src.startsWith("$$", start)) return false;
    const end = findClosing(state.src, closing, start + marker.length);
    if (end < 0) return false;
    const content = state.src.slice(start + marker.length, end);
    if (!content.trim()) return false;
    if (!silent) {
      const token = state.push(
        display ? "math_display" : "math_inline",
        "math",
        0,
      );
      token.content = content;
      token.markup = marker;
    }
    state.pos = end + closing.length;
    return true;
  };
}

/** Parse math into tokens; rendering remains a React responsibility. */
export default function markdownMathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("escape", "math_display_dollars", inlineMath("$$"));
  md.inline.ruler.before("escape", "math_display_brackets", inlineMath("\\["));
  md.inline.ruler.before("escape", "math_inline_parens", inlineMath("\\("));
  md.inline.ruler.before("escape", "math_inline_dollars", inlineMath("$"));
}
