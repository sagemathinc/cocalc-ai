/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export function stripTrailingNewlines(markdown: string): string {
  return markdown.replace(/\n+$/g, "");
}

export function normalizeBlockMarkdown(markdown: string): string {
  return stripTrailingNewlines(markdown);
}

export function joinBlocks(blocks: string[]): string {
  const cleaned = blocks.map((block) => normalizeBlockMarkdown(block));
  return cleaned.join("\n\n");
}

export function globalIndexForBlockOffset(
  blocks: string[],
  blockIndex: number,
  offset: number,
): number {
  let index = 0;
  const last = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const block = normalizeBlockMarkdown(blocks[i] ?? "");
    const blockLen = block.length;
    if (i === blockIndex) {
      const clamped = Math.max(0, Math.min(offset, blockLen));
      return index + clamped;
    }
    index += blockLen;
    if (i < last) {
      index += 2; // separator \n\n
    }
  }
  return index;
}

export function blockOffsetForGlobalIndex(
  blocks: string[],
  globalIndex: number,
): { index: number; offset: number } {
  const safeIndex = Math.max(0, globalIndex);
  let cursor = 0;
  const last = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    const block = normalizeBlockMarkdown(blocks[i] ?? "");
    const blockLen = block.length;
    const blockEnd = cursor + blockLen;
    if (safeIndex <= blockEnd) {
      return { index: i, offset: Math.max(0, safeIndex - cursor) };
    }
    cursor = blockEnd;
    if (i < last) {
      const separatorEnd = cursor + 2;
      if (safeIndex <= separatorEnd) {
        return { index: i + 1, offset: 0 };
      }
      cursor = separatorEnd;
    }
  }
  if (blocks.length === 0) {
    return { index: 0, offset: 0 };
  }
  const lastBlock = normalizeBlockMarkdown(blocks[last] ?? "");
  return { index: last, offset: lastBlock.length };
}

export type GlobalSelectionRange = { start: number; end: number };

export function findNextMatchIndex(
  fullMarkdown: string,
  query: string,
  selection: GlobalSelectionRange | null,
  lastMatchIndex: number | null,
): number | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const lower = fullMarkdown.toLowerCase();
  const length = normalized.length;
  let from =
    lastMatchIndex != null ? lastMatchIndex + length : selection?.end ?? 0;
  if (from < 0) from = 0;
  let idx = lower.indexOf(normalized, from);
  if (idx === -1 && from > 0) {
    idx = lower.indexOf(normalized, 0);
  }
  return idx === -1 ? null : idx;
}

export function findPreviousMatchIndex(
  fullMarkdown: string,
  query: string,
  selection: GlobalSelectionRange | null,
  lastMatchIndex: number | null,
): number | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const lower = fullMarkdown.toLowerCase();
  let from =
    lastMatchIndex != null
      ? lastMatchIndex - 1
      : selection?.start ?? lower.length;
  if (from < 0) {
    const wrapped = lower.lastIndexOf(normalized);
    return wrapped === -1 ? null : wrapped;
  }
  if (from > lower.length) from = lower.length;
  let idx = lower.lastIndexOf(normalized, from);
  if (idx === -1 && from < lower.length) {
    idx = lower.lastIndexOf(normalized);
  }
  return idx === -1 ? null : idx;
}
