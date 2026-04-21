/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const LARGE_UNFOCUSED_DIRECT_SET_CHARS = 50_000;
const LARGE_UNFOCUSED_DIRECT_SET_BLOCKS = 250;

export function shouldDirectSetExternalSlateValue({
  forceDirectSetForClear,
  previousBlockCount,
  nextBlockCount,
  nextMarkdownLength,
  isMergeFocused,
}: {
  forceDirectSetForClear: boolean;
  previousBlockCount: number;
  nextBlockCount: number;
  nextMarkdownLength: number;
  isMergeFocused: boolean;
}): boolean {
  if (forceDirectSetForClear) return true;
  if (previousBlockCount <= 1 && nextBlockCount >= 40 && !isMergeFocused) {
    return true;
  }
  if (isMergeFocused) return false;
  return (
    nextMarkdownLength >= LARGE_UNFOCUSED_DIRECT_SET_CHARS ||
    Math.max(previousBlockCount, nextBlockCount) >=
      LARGE_UNFOCUSED_DIRECT_SET_BLOCKS
  );
}
