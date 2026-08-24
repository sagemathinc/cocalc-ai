/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Split a plain-text document into the "blocks" the block minimap draws.

A block is a run of consecutive non-blank lines; one or more blank lines end
it.  That is the text-editor analogue of a notebook cell: a paragraph, a
function body, an indented chunk of a config file.  Blank runs become the gaps
between the bars, which is what makes the map readable at a glance.

Very long documents are collapsed to at most `maxBlocks` bars by merging
neighbouring blocks, so a 50k-line file does not create 10k DOM nodes.
*/

export interface TextBlock {
  id: string;
  startLine: number; // inclusive, 0-based
  endLine: number; // inclusive, 0-based
}

export const TEXT_BLOCK_DEFAULT_MAX = 1200;

export function computeTextBlocks({
  lineCount,
  getLine,
  maxBlocks = TEXT_BLOCK_DEFAULT_MAX,
}: {
  lineCount: number;
  getLine: (n: number) => string;
  maxBlocks?: number;
}): TextBlock[] {
  if (lineCount <= 0) return [];
  const raw: Array<{ startLine: number; endLine: number }> = [];
  let start: number | null = null;
  for (let i = 0; i < lineCount; i += 1) {
    const blank = (getLine(i) ?? "").trim().length === 0;
    if (blank) {
      if (start != null) {
        raw.push({ startLine: start, endLine: i - 1 });
        start = null;
      }
    } else if (start == null) {
      start = i;
    }
  }
  if (start != null) raw.push({ startLine: start, endLine: lineCount - 1 });
  // A document of only blank lines still deserves a single bar.
  if (raw.length === 0) raw.push({ startLine: 0, endLine: lineCount - 1 });

  if (raw.length <= maxBlocks) {
    return raw.map((b) => ({ ...b, id: `b${b.startLine}` }));
  }

  const groupSize = Math.ceil(raw.length / maxBlocks);
  const merged: TextBlock[] = [];
  for (let i = 0; i < raw.length; i += groupSize) {
    const first = raw[i];
    const last = raw[Math.min(raw.length - 1, i + groupSize - 1)];
    merged.push({
      id: `b${first.startLine}`,
      startLine: first.startLine,
      endLine: last.endLine,
    });
  }
  return merged;
}

/** Index of the block containing `line`, or -1. Blocks are sorted and disjoint. */
export function findTextBlockIndex(blocks: TextBlock[], line: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = blocks[mid];
    if (line < b.startLine) {
      hi = mid - 1;
    } else if (line > b.endLine) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return -1;
}

/**
 * Index of the block containing `line`, or of the nearest one when `line` is a
 * blank separator between blocks.  The minimap uses this for the
 * cursor highlight, which should never blink out just because the caret
 * happens to rest on an empty line.
 */
export function nearestTextBlockIndex(
  blocks: TextBlock[],
  line: number,
): number {
  if (blocks.length === 0) return -1;
  const exact = findTextBlockIndex(blocks, line);
  if (exact >= 0) return exact;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].endLine < line) return i;
  }
  return 0;
}
