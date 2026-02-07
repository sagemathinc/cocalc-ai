/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Descendant,
  Editor,
  Element,
  Node,
  Path,
  Point,
  Range,
  Text,
  Transforms,
} from "slate";
import { apply_patch, diff_main, make_patch } from "@cocalc/util/dmp";
import { hash_string } from "@cocalc/util/misc";

const SIGNATURE_START = 0xe000; // private use area

export type BlockDiffOp = "equal" | "insert" | "delete";

export interface BlockSignature {
  type: string;
  payload: string;
  signature: string;
}

export interface BlockDiffChunk {
  op: BlockDiffOp;
  prevIndex: number;
  nextIndex: number;
  count: number;
}

export function shouldDeferBlockPatch(
  chunks: BlockDiffChunk[],
  activeBlockIndex: number | undefined,
  recentlyTyped: boolean,
): boolean {
  if (!recentlyTyped || activeBlockIndex == null) return false;
  return chunks.some(
    (chunk) =>
      chunk.op === "delete" &&
      activeBlockIndex >= chunk.prevIndex &&
      activeBlockIndex < chunk.prevIndex + chunk.count,
  );
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function blockPayload(node: Descendant): string {
  if (!Element.isElement(node)) {
    return Text.isText(node) ? node.text : "";
  }
  const type = node.type ?? "unknown";
  switch (type) {
    case "code_block": {
      const info = (node as any).info ?? "";
      return `code:${info}:${Node.string(node)}`;
    }
    case "html_block": {
      const html = (node as any).html ?? Node.string(node);
      return `html:${html}`;
    }
    case "meta": {
      const value = (node as any).value ?? Node.string(node);
      return `meta:${value}`;
    }
    case "math_block": {
      const value = (node as any).value ?? Node.string(node);
      return `math:${value}`;
    }
    case "bullet_list":
    case "ordered_list":
      return `${type}:${Node.string(node)}`;
    case "paragraph":
      return `p:${normalizeText(Node.string(node))}`;
    default:
      return `${type}:${Node.string(node)}`;
  }
}

export function buildBlockSignature(node: Descendant): BlockSignature {
  const type = Element.isElement(node) ? node.type ?? "unknown" : "text";
  const payload = blockPayload(node);
  const signature = `${type}:${hash_string(payload)}:${payload.length}`;
  return { type, payload, signature };
}

export function buildBlockSignatureList(doc: Descendant[]): BlockSignature[] {
  return doc.map((node) => buildBlockSignature(node));
}

function signatureAlphabet(signatures: string[]): Map<string, string> {
  const map = new Map<string, string>();
  let code = SIGNATURE_START;
  for (const sig of signatures) {
    if (map.has(sig)) continue;
    map.set(sig, String.fromCharCode(code));
    code += 1;
  }
  return map;
}

function encodeSignatures(
  list: BlockSignature[],
  alphabet: Map<string, string>,
): string {
  return list.map((sig) => alphabet.get(sig.signature) ?? "").join("");
}

export function diffBlockSignatures(
  prev: Descendant[],
  next: Descendant[],
): BlockDiffChunk[] {
  const prevList = buildBlockSignatureList(prev);
  const nextList = buildBlockSignatureList(next);
  const alphabet = signatureAlphabet([
    ...prevList.map((s) => s.signature),
    ...nextList.map((s) => s.signature),
  ]);
  const prevText = encodeSignatures(prevList, alphabet);
  const nextText = encodeSignatures(nextList, alphabet);
  const diffs = diff_main(prevText, nextText);

  let prevIndex = 0;
  let nextIndex = 0;
  const chunks: BlockDiffChunk[] = [];
  for (const [op, text] of diffs) {
    if (!text) continue;
    const count = text.length;
    if (op === 0) {
      chunks.push({ op: "equal", prevIndex, nextIndex, count });
      prevIndex += count;
      nextIndex += count;
    } else if (op === -1) {
      chunks.push({ op: "delete", prevIndex, nextIndex, count });
      prevIndex += count;
    } else if (op === 1) {
      chunks.push({ op: "insert", prevIndex, nextIndex, count });
      nextIndex += count;
    }
  }
  return chunks;
}

export function applyBlockDiffPatch(
  editor: Editor,
  prev: Descendant[],
  next: Descendant[],
  chunks: BlockDiffChunk[] = diffBlockSignatures(prev, next),
): { chunks: BlockDiffChunk[]; applied: boolean } {
  const hasChanges = chunks.some((chunk) => chunk.op !== "equal");
  if (!hasChanges) {
    return { chunks, applied: true };
  }
  // First apply deletes in reverse order to avoid index shifting.
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (chunk.op !== "delete") continue;
    for (
      let idx = chunk.prevIndex + chunk.count - 1;
      idx >= chunk.prevIndex;
      idx -= 1
    ) {
      if (idx < 0 || idx >= editor.children.length) continue;
      Transforms.removeNodes(editor, { at: [idx] });
    }
  }
  // Then apply inserts in forward order.
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk.op !== "insert") continue;
    const nodes = next.slice(chunk.nextIndex, chunk.nextIndex + chunk.count);
    if (nodes.length === 0) continue;
    const atIndex = Math.min(chunk.nextIndex, editor.children.length);
    Transforms.insertNodes(editor, nodes, { at: [atIndex] });
  }
  return { chunks, applied: true };
}

function mapPointByBlockDiff(
  editor: Editor,
  point: Point,
  chunks: BlockDiffChunk[],
): { point: Point; deleted: boolean; mappedIndex: number } | null {
  const prevIndex = point.path[0] ?? 0;
  let mappedIndex = 0;
  let deleted = false;
  let found = false;
  for (const chunk of chunks) {
    if (chunk.op === "equal") {
      if (
        prevIndex >= chunk.prevIndex &&
        prevIndex < chunk.prevIndex + chunk.count
      ) {
        mappedIndex = chunk.nextIndex + (prevIndex - chunk.prevIndex);
        deleted = false;
        found = true;
        break;
      }
      continue;
    }
    if (chunk.op === "delete") {
      if (
        prevIndex >= chunk.prevIndex &&
        prevIndex < chunk.prevIndex + chunk.count
      ) {
        mappedIndex = chunk.nextIndex;
        deleted = true;
        found = true;
        break;
      }
    }
  }
  if (!found) {
    mappedIndex = Math.min(prevIndex, editor.children.length - 1);
    deleted = mappedIndex !== prevIndex;
  }
  if (mappedIndex < 0 || mappedIndex >= editor.children.length) {
    return null;
  }
  if (deleted) {
    const start = Editor.start(editor, [mappedIndex]);
    return { point: start, deleted: true, mappedIndex };
  }
  const path = [mappedIndex, ...point.path.slice(1)];
  try {
    const mapped = Editor.point(editor, path, { edge: "start" });
    return {
      point: { path: mapped.path, offset: point.offset },
      deleted: false,
      mappedIndex,
    };
  } catch (err) {
    const start = Editor.start(editor, [mappedIndex]);
    return { point: start, deleted: true, mappedIndex };
  }
}

function pointOffsetInBlock(
  block: Descendant,
  pathInBlock: Path,
  offset: number,
): number {
  let total = 0;
  for (const [node, path] of Node.texts(block)) {
    if (Path.equals(path, pathInBlock)) {
      return total + offset;
    }
    total += node.text.length;
  }
  return total;
}

function pointFromBlockOffset(
  block: Descendant,
  blockIndex: number,
  offset: number,
): Point {
  let total = 0;
  let lastPath: Path | null = null;
  let lastLength = 0;
  for (const [node, path] of Node.texts(block)) {
    const nextTotal = total + node.text.length;
    if (offset <= nextTotal) {
      return { path: [blockIndex, ...path], offset: Math.max(0, offset - total) };
    }
    total = nextTotal;
    lastPath = path;
    lastLength = node.text.length;
  }
  if (lastPath) {
    return { path: [blockIndex, ...lastPath], offset: lastLength };
  }
  return Editor.start({ children: [block] } as any, [0]);
}

function pointOffsetInDoc(
  doc: Descendant[],
  pathInDoc: Path,
  offset: number,
): number {
  let total = 0;
  const root = { children: doc } as Descendant;
  for (const [node, path] of Node.texts(root)) {
    if (Path.equals(path, pathInDoc)) {
      return total + offset;
    }
    total += node.text.length;
  }
  return total;
}

function pointFromDocOffset(doc: Descendant[], offset: number): Point {
  let total = 0;
  let lastPath: Path | null = null;
  let lastLength = 0;
  const root = { children: doc } as Descendant;
  for (const [node, path] of Node.texts(root)) {
    const nextTotal = total + node.text.length;
    if (offset <= nextTotal) {
      return { path, offset: Math.max(0, offset - total) };
    }
    total = nextTotal;
    lastPath = path;
    lastLength = node.text.length;
  }
  if (lastPath) {
    return { path: lastPath, offset: lastLength };
  }
  return Editor.start({ children: doc } as any, [0]);
}

function insertAt(text: string, index: number, marker: string): string {
  return text.slice(0, index) + marker + text.slice(index);
}

function pickSentinel(text: string, start: number): string {
  let code = start;
  let marker = String.fromCharCode(code);
  while (text.includes(marker)) {
    code += 1;
    marker = String.fromCharCode(code);
  }
  return marker;
}

export function remapSelectionAfterBlockPatch(
  editor: Editor,
  prevSelection: Range,
  chunks: BlockDiffChunk[],
): Range | null {
  const anchorMap = mapPointByBlockDiff(editor, prevSelection.anchor, chunks);
  const focusMap = mapPointByBlockDiff(editor, prevSelection.focus, chunks);
  if (!anchorMap || !focusMap) return null;
  if (anchorMap.deleted || focusMap.deleted) {
    return {
      anchor: anchorMap.point,
      focus: anchorMap.point,
    };
  }
  return {
    anchor: anchorMap.point,
    focus: focusMap.point,
  };
}

export function remapSelectionAfterBlockPatchWithSentinels(
  editor: Editor,
  prevSelection: Range,
  prev: Descendant[],
  next: Descendant[],
  chunks: BlockDiffChunk[],
): Range | null {
  const base = remapSelectionAfterBlockPatch(editor, prevSelection, chunks);
  if (!base) return null;

  const prevAnchorIndex = prevSelection.anchor.path[0];
  const prevFocusIndex = prevSelection.focus.path[0];
  if (
    prevAnchorIndex == null ||
    prevFocusIndex == null ||
    prevAnchorIndex !== prevFocusIndex
  ) {
    return base;
  }

  const anchorMap = mapPointByBlockDiff(editor, prevSelection.anchor, chunks);
  const focusMap = mapPointByBlockDiff(editor, prevSelection.focus, chunks);
  if (!anchorMap || !focusMap) return base;
  const mappedIndex = anchorMap.mappedIndex;
  if (mappedIndex == null || mappedIndex >= next.length) return base;

  const prevBlock = prev[prevAnchorIndex];
  const nextBlock = next[mappedIndex];
  if (!prevBlock || !nextBlock) return base;

  const prevSig = buildBlockSignature(prevBlock).signature;
  const nextSig = buildBlockSignature(nextBlock).signature;
  if (prevSig === nextSig) {
    return base;
  }

  const prevText = Node.string(prevBlock);
  const nextText = Node.string(nextBlock);
  if (!prevText) return base;

  const anchorOffset = pointOffsetInBlock(
    prevBlock,
    prevSelection.anchor.path.slice(1),
    prevSelection.anchor.offset,
  );
  const focusOffset = pointOffsetInBlock(
    prevBlock,
    prevSelection.focus.path.slice(1),
    prevSelection.focus.offset,
  );

  let anchorMarker = pickSentinel(prevText, 0xe000);
  let focusMarker = pickSentinel(prevText + anchorMarker, 0xe001);
  let textWithMarkers = prevText;
  if (anchorOffset === focusOffset) {
    focusMarker = anchorMarker;
  }

  if (anchorOffset <= focusOffset) {
    textWithMarkers = insertAt(textWithMarkers, anchorOffset, anchorMarker);
    if (anchorOffset !== focusOffset) {
      textWithMarkers = insertAt(
        textWithMarkers,
        focusOffset + anchorMarker.length,
        focusMarker,
      );
    }
  } else {
    textWithMarkers = insertAt(textWithMarkers, focusOffset, focusMarker);
    textWithMarkers = insertAt(
      textWithMarkers,
      anchorOffset + focusMarker.length,
      anchorMarker,
    );
  }

  const patch = make_patch(prevText, nextText);
  const [patchedText] = apply_patch(patch, textWithMarkers);

  const anchorIdx = patchedText.indexOf(anchorMarker);
  const focusIdx = patchedText.indexOf(focusMarker);
  if (anchorIdx < 0 || focusIdx < 0) {
    return base;
  }

  const markerIndices =
    anchorMarker === focusMarker
      ? [anchorIdx]
      : [anchorIdx, focusIdx];
  const adjustIndex = (idx: number) =>
    idx - markerIndices.filter((marker) => marker < idx).length;

  const anchorPoint = pointFromBlockOffset(
    nextBlock,
    mappedIndex,
    adjustIndex(anchorIdx),
  );
  const focusPoint =
    anchorMarker === focusMarker
      ? anchorPoint
      : pointFromBlockOffset(nextBlock, mappedIndex, adjustIndex(focusIdx));

  return { anchor: anchorPoint, focus: focusPoint };
}

export function remapSelectionInDocWithSentinels(
  prevDoc: Descendant[],
  nextDoc: Descendant[],
  prevSelection: Range,
): Range | null {
  const prevText = Node.string({ children: prevDoc } as any);
  const nextText = Node.string({ children: nextDoc } as any);
  if (!prevText) return null;

  const anchorOffset = pointOffsetInDoc(
    prevDoc,
    prevSelection.anchor.path,
    prevSelection.anchor.offset,
  );
  const focusOffset = pointOffsetInDoc(
    prevDoc,
    prevSelection.focus.path,
    prevSelection.focus.offset,
  );

  let anchorMarker = pickSentinel(prevText, 0xe000);
  let focusMarker = pickSentinel(prevText + anchorMarker, 0xe001);
  let textWithMarkers = prevText;
  if (anchorOffset === focusOffset) {
    focusMarker = anchorMarker;
  }

  if (anchorOffset <= focusOffset) {
    textWithMarkers = insertAt(textWithMarkers, anchorOffset, anchorMarker);
    if (anchorOffset !== focusOffset) {
      textWithMarkers = insertAt(
        textWithMarkers,
        focusOffset + anchorMarker.length,
        focusMarker,
      );
    }
  } else {
    textWithMarkers = insertAt(textWithMarkers, focusOffset, focusMarker);
    textWithMarkers = insertAt(
      textWithMarkers,
      anchorOffset + focusMarker.length,
      anchorMarker,
    );
  }

  const patch = make_patch(prevText, nextText);
  const [patchedText] = apply_patch(patch, textWithMarkers);

  const anchorIdx = patchedText.indexOf(anchorMarker);
  const focusIdx = patchedText.indexOf(focusMarker);
  if (anchorIdx < 0 || focusIdx < 0) return null;

  const markerIndices =
    anchorMarker === focusMarker
      ? [anchorIdx]
      : [anchorIdx, focusIdx];
  const adjustIndex = (idx: number) =>
    idx - markerIndices.filter((marker) => marker < idx).length;

  const anchorPoint = pointFromDocOffset(nextDoc, adjustIndex(anchorIdx));
  const focusPoint =
    anchorMarker === focusMarker
      ? anchorPoint
      : pointFromDocOffset(nextDoc, adjustIndex(focusIdx));

  return { anchor: anchorPoint, focus: focusPoint };
}
