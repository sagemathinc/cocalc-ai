/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  computeTextBlocks,
  findTextBlockIndex,
  nearestTextBlockIndex,
} from "./text-blocks";

function blocksOf(text: string, maxBlocks?: number) {
  const lines = text.split("\n");
  return computeTextBlocks({
    lineCount: lines.length,
    getLine: (n) => lines[n],
    maxBlocks,
  });
}

describe("computeTextBlocks", () => {
  it("splits on runs of blank lines", () => {
    const blocks = blocksOf("a\nb\n\n\nc\n\nd");
    expect(blocks.map((b) => [b.startLine, b.endLine])).toEqual([
      [0, 1],
      [4, 4],
      [6, 6],
    ]);
  });

  it("treats whitespace-only lines as blank", () => {
    expect(blocksOf("a\n   \t \nb").map((b) => b.startLine)).toEqual([0, 2]);
  });

  it("returns one block for a document without blank lines", () => {
    expect(blocksOf("a\nb\nc")).toHaveLength(1);
  });

  it("returns a single block for an all-blank document", () => {
    const blocks = blocksOf("\n\n\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ startLine: 0, endLine: 3 });
  });

  it("returns [] for an empty document", () => {
    expect(computeTextBlocks({ lineCount: 0, getLine: () => "" })).toEqual([]);
  });

  it("merges neighbours to stay under maxBlocks", () => {
    const text = Array.from({ length: 100 }, (_, i) => `x${i}\n`).join("\n");
    const blocks = blocksOf(text, 10);
    expect(blocks.length).toBeLessThanOrEqual(10);
    // merged blocks still cover the document in order, without gaps in ids
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i].startLine).toBeGreaterThan(blocks[i - 1].endLine);
    }
  });
});

describe("findTextBlockIndex", () => {
  const blocks = blocksOf("a\nb\n\nc\n\n\nd");
  it("finds the block containing a line", () => {
    expect(findTextBlockIndex(blocks, 1)).toBe(0);
    expect(findTextBlockIndex(blocks, 3)).toBe(1);
    expect(findTextBlockIndex(blocks, 6)).toBe(2);
  });
  it("returns -1 for a blank separator line", () => {
    expect(findTextBlockIndex(blocks, 2)).toBe(-1);
  });
});

describe("nearestTextBlockIndex", () => {
  const blocks = blocksOf("a\nb\n\nc\n\n\nd");

  it("agrees with findTextBlockIndex inside a block", () => {
    for (const line of [0, 1, 3, 6]) {
      expect(nearestTextBlockIndex(blocks, line)).toBe(
        findTextBlockIndex(blocks, line),
      );
    }
  });

  it("falls back to the preceding block on a separator line", () => {
    expect(nearestTextBlockIndex(blocks, 2)).toBe(0);
    expect(nearestTextBlockIndex(blocks, 4)).toBe(1);
    expect(nearestTextBlockIndex(blocks, 5)).toBe(1);
  });

  it("returns -1 only when there are no blocks", () => {
    expect(nearestTextBlockIndex([], 3)).toBe(-1);
  });
});
