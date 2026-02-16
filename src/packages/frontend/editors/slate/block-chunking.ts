/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
// Chunking helpers split markdown into block-sized chunks and compute incremental
// slices for efficient updates. This keeps block-markdown-editor-core focused on
// orchestration while providing a centralized place for chunking policy.

import { Element as SlateElement, Node } from "slate";
import { markdown_to_slate } from "./markdown-to-slate";
import { slate_to_markdown } from "./slate-to-markdown";
import { normalizeBlockMarkdown } from "./block-markdown-utils";

const BLOCK_CHUNK_TARGET_CHARS = 4000;

function getBlockChunkTargetChars(): number {
  if (typeof globalThis === "undefined") return BLOCK_CHUNK_TARGET_CHARS;
  const value = (globalThis as any).COCALC_SLATE_BLOCK_CHUNK_CHARS;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return BLOCK_CHUNK_TARGET_CHARS;
}

export function splitMarkdownToBlocks(markdown: string): string[] {
  if (!markdown) return [""];
  const cache: { [node: string]: string } = {};
  const doc = markdown_to_slate(markdown, false, cache);
  const filtered = doc.filter(
    (node) => !(node?.["type"] === "paragraph" && node?.["blank"] === true),
  );
  if (filtered.length === 0) return [""];
  const nodeMarkdown = filtered.map((node) => {
    if (SlateElement.isElement(node) && node.type === "code_block") {
      const info = (node as any).info ? String((node as any).info).trim() : "";
      const lines = Array.isArray(node.children)
        ? node.children.map((child) => Node.string(child))
        : [];
      const fence = "```" + info;
      return normalizeBlockMarkdown([fence, ...lines, "```"].join("\n"));
    }
    return normalizeBlockMarkdown(
      slate_to_markdown([node], { cache, preserveBlankLines: false }),
    );
  });
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLength = 0;
  const targetChars = getBlockChunkTargetChars();
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n\n"));
    current = [];
    currentLength = 0;
  };
  for (const block of nodeMarkdown) {
    const blockLength = block.length;
    const nextLength =
      currentLength === 0 ? blockLength : currentLength + 2 + blockLength;
    if (current.length > 0 && nextLength > targetChars) {
      flush();
    }
    current.push(block);
    currentLength =
      currentLength === 0 ? blockLength : currentLength + 2 + blockLength;
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) {
    i += 1;
  }
  return i;
}

function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix;
  let i = 0;
  while (
    i < max &&
    a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)
  ) {
    i += 1;
  }
  return i;
}

export type IncrementalSlices = {
  prefixBlocks: string[];
  suffixBlocks: string[];
  middleText: string;
};

export function computeIncrementalSlices(
  prevMarkdown: string,
  nextMarkdown: string,
  prevBlocks: string[],
): IncrementalSlices | null {
  const prefix = commonPrefixLength(prevMarkdown, nextMarkdown);
  const suffix = commonSuffixLength(prevMarkdown, nextMarkdown, prefix);
  const oldLength = prevMarkdown.length;
  const suffixStartOld = oldLength - suffix;

  let prefixIndex = 0;
  let prefixOffset = 0;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const blockLen = prevBlocks[i].length;
    const sep = i < prevBlocks.length - 1 ? 2 : 0;
    const nextOffset = prefixOffset + blockLen + sep;
    if (prefix >= nextOffset) {
      prefixOffset = nextOffset;
      prefixIndex = i + 1;
      continue;
    }
    break;
  }

  let suffixIndex = prevBlocks.length;
  let suffixStartOffset = oldLength;
  let offset = 0;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const blockLen = prevBlocks[i].length;
    const sep = i < prevBlocks.length - 1 ? 2 : 0;
    const nextOffset = offset + blockLen + sep;
    if (suffixStartOld <= offset) {
      suffixIndex = i;
      suffixStartOffset = offset;
      break;
    }
    if (suffixStartOld < nextOffset) {
      suffixIndex = i + 1;
      suffixStartOffset = nextOffset;
      break;
    }
    offset = nextOffset;
  }
  if (suffixIndex >= prevBlocks.length) {
    suffixStartOffset = oldLength;
  }

  const prefixBlocks = prefixIndex > 0 ? prevBlocks.slice(0, prefixIndex) : [];
  const suffixBlocks =
    suffixIndex < prevBlocks.length ? prevBlocks.slice(suffixIndex) : [];
  const suffixReuseLen = Math.max(0, oldLength - suffixStartOffset);
  const middleStart = prefixOffset;
  const middleEnd = nextMarkdown.length - suffixReuseLen;

  if (middleStart < 0 || middleEnd < middleStart) {
    return null;
  }

  const middleText = nextMarkdown.slice(middleStart, middleEnd);
  return { prefixBlocks, suffixBlocks, middleText };
}

export function splitMarkdownToBlocksIncremental(
  prevMarkdown: string,
  nextMarkdown: string,
  prevBlocks: string[],
): string[] {
  if (!prevMarkdown) return splitMarkdownToBlocks(nextMarkdown);
  if (prevBlocks.length === 0) return splitMarkdownToBlocks(nextMarkdown);
  if (prevMarkdown === nextMarkdown) return prevBlocks;
  const slices = computeIncrementalSlices(
    prevMarkdown,
    nextMarkdown,
    prevBlocks,
  );
  if (!slices) {
    return splitMarkdownToBlocks(nextMarkdown);
  }
  const { prefixBlocks, suffixBlocks, middleText } = slices;
  const middleBlocks =
    middleText.length > 0 ? splitMarkdownToBlocks(middleText) : [];
  const nextBlocks = [...prefixBlocks, ...middleBlocks, ...suffixBlocks];
  return nextBlocks.length > 0 ? nextBlocks : [""];
}
