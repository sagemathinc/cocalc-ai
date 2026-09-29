/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Top-level markdown block boundaries, found with a line scanner instead of a
// full parser so callers can run it on every streamed update of a long turn.
// A boundary is a run of blank lines outside fenced code/display math followed by
// an unindented line; indented lines usually continue a list item, so they are
// not treated as a new block.

export interface MarkdownBlockBoundary {
  // Offset where the blank-line separator starts (end of the previous block).
  end: number;
  // Offset of the first character of the next block.
  start: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DISPLAY_MATH = /^ {0,3}(\$\$|\\\[|\\begin\{([a-z]+\*?)\})/;

export function markdownBlockBoundaries(
  text: string,
  from = 0,
): MarkdownBlockBoundary[] {
  const boundaries: MarkdownBlockBoundary[] = [];
  let fence: { char: string; length: number } | undefined;
  let mathClose: string | undefined;
  let blankStart: number | undefined;
  let sawContent = false;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    const lineEnd = newline < 0 ? text.length : newline;
    const line = text.slice(offset, lineEnd);
    const next = newline < 0 ? text.length : newline + 1;
    if (mathClose != null) {
      if (line.includes(mathClose)) mathClose = undefined;
      offset = next;
      continue;
    }
    if (fence != null) {
      const match = FENCE.exec(line);
      if (
        match &&
        match[1][0] === fence.char &&
        match[1].length >= fence.length &&
        line.slice(match[0].length).trim() === ""
      ) {
        fence = undefined;
      }
      offset = next;
      continue;
    }
    if (line.trim() === "") {
      // A separator starts where the previous block's last line ends.
      if (sawContent && blankStart == null)
        blankStart = Math.max(0, offset - 1);
      offset = next;
      continue;
    }
    if (blankStart != null && !/^[ \t]/.test(line) && offset >= from) {
      boundaries.push({ end: blankStart, start: offset });
    }
    blankStart = undefined;
    sawContent = true;
    const match = FENCE.exec(line);
    if (match) {
      fence = { char: match[1][0], length: match[1].length };
    } else {
      const math = DISPLAY_MATH.exec(line);
      if (math) {
        const close =
          math[1] === "$$"
            ? "$$"
            : math[1] === "\\["
              ? "\\]"
              : `\\end{${math[2]}}`;
        if (!line.slice(math[0].length).includes(close)) mathClose = close;
      }
    }
    offset = next;
  }
  return boundaries;
}

// The first boundary at or after `from`: where the block that was being
// written at offset `from` is complete and the next one begins.
export function nextMarkdownBlockBoundary(
  text: string,
  from: number,
): MarkdownBlockBoundary | undefined {
  return markdownBlockBoundaries(text, from)[0];
}
