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
import { diff_main } from "@cocalc/util/dmp";
import { hash_string } from "@cocalc/util/misc";
import { slate_to_markdown } from "../slate-to-markdown";

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
    default:
      // The signature must change whenever the block's content changes,
      // including structure-only changes such as list nesting or marks, which
      // leave the concatenated text unchanged. Otherwise a focused editor
      // treats the remote block as already applied and silently keeps stale
      // content that its next save writes back.
      return `${type}:${blockMarkdown(node)}`;
  }
}

function blockMarkdown(node: Element): string {
  try {
    return slate_to_markdown([node]);
  } catch {
    return JSON.stringify(node);
  }
}

export function buildBlockSignature(node: Descendant): BlockSignature {
  const type = Element.isElement(node) ? (node.type ?? "unknown") : "text";
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
      return {
        path: [blockIndex, ...path],
        offset: Math.max(0, offset - total),
      };
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

// The offset in `next` of the position `offset` in `prev`. Unchanged words
// (and runs of whitespace) are aligned by a diff of whole words, so a caret
// never lands inside a different word (a character diff can align similar
// words wrongly); within text that changed it is mapped by characters. A
// caret at the place where text was inserted stays in front of it (as
// CodeMirror maps a cursor), so it does not jump into what a collaborator is
// typing there and interleave with it.
function mapTextOffset(prev: string, next: string, offset: number): number {
  let mapped = mapTextOffsetByWords(prev, next, offset);
  // A caret at the end of a word that a collaborator extended (they were
  // still typing it) goes past the rest of the word, not into it.
  const word = /[\p{L}\p{N}_]/u;
  if (
    offset > 0 &&
    word.test(prev[offset - 1]) &&
    !word.test(prev[offset] ?? "") &&
    word.test(next[mapped - 1] ?? "") &&
    word.test(next[mapped] ?? "")
  ) {
    while (mapped < next.length && word.test(next[mapped])) mapped++;
  }
  return mapped;
}

function mapTextOffsetByWords(
  prev: string,
  next: string,
  offset: number,
): number {
  const tokens = (text: string) => text.match(/\s+|\S+/g) ?? [];
  const a = tokens(prev);
  const b = tokens(next);
  const ids = new Map<string, string>();
  const encode = (list: string[]) =>
    list
      .map((token) => {
        let id = ids.get(token);
        if (id == null) {
          id = String.fromCharCode(ids.size + 1);
          ids.set(token, id);
        }
        return id;
      })
      .join("");
  const x = encode(a);
  const y = encode(b);
  if (ids.size >= 0xffff) return mapChangedText(prev, next, offset);
  let p = 0;
  let n = 0;
  let i = 0;
  let j = 0;
  let deleted = "";
  let inserted = "";
  // A changed region (deleted and inserted tokens between unchanged ones).
  const region = (): number | undefined => {
    const result =
      deleted === ""
        ? offset === p
          ? n
          : undefined
        : offset >= p && offset <= p + deleted.length
          ? n + mapChangedText(deleted, inserted, offset - p)
          : undefined;
    p += deleted.length;
    n += inserted.length;
    deleted = "";
    inserted = "";
    return result;
  };
  for (const [op, run] of diff_main(x, y)) {
    for (let k = 0; k < run.length; k++) {
      if (op === 0) {
        const mapped = region();
        if (mapped != null) return mapped;
        const length = a[i++].length;
        j++;
        if (offset <= p + length) return n + (offset - p);
        p += length;
        n += length;
      } else if (op === -1) {
        deleted += a[i++];
      } else {
        inserted += b[j++];
      }
    }
  }
  return region() ?? n;
}

// mapTextOffset by characters, for text that changed.
function mapChangedText(prev: string, next: string, offset: number): number {
  let p = 0;
  let n = 0;
  for (const [op, text] of diff_main(prev, next)) {
    if (op === 0) {
      if (offset <= p + text.length) return n + (offset - p);
      p += text.length;
      n += text.length;
    } else if (op === -1) {
      if (offset < p + text.length) return n;
      p += text.length;
    } else {
      if (offset === p) return n;
      n += text.length;
    }
  }
  return n;
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

  const anchorPoint = pointFromBlockOffset(
    nextBlock,
    mappedIndex,
    mapTextOffset(prevText, nextText, anchorOffset),
  );
  const focusPoint =
    anchorOffset === focusOffset
      ? anchorPoint
      : pointFromBlockOffset(
          nextBlock,
          mappedIndex,
          mapTextOffset(prevText, nextText, focusOffset),
        );

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

  const anchorPoint = pointFromDocOffset(
    nextDoc,
    mapTextOffset(prevText, nextText, anchorOffset),
  );
  const focusPoint =
    anchorOffset === focusOffset
      ? anchorPoint
      : pointFromDocOffset(
          nextDoc,
          mapTextOffset(prevText, nextText, focusOffset),
        );

  return { anchor: anchorPoint, focus: focusPoint };
}
