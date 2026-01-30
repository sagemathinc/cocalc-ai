/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  Descendant,
  Editor,
  Element,
  Node,
  Point,
  Range,
  Text,
  Transforms,
} from "slate";
import { diff_main } from "@cocalc/util/dmp";
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
): { point: Point; deleted: boolean } | null {
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
    return { point: start, deleted: true };
  }
  const path = [mappedIndex, ...point.path.slice(1)];
  try {
    const mapped = Editor.point(editor, path, { edge: "start" });
    return { point: { path: mapped.path, offset: point.offset }, deleted: false };
  } catch (err) {
    const start = Editor.start(editor, [mappedIndex]);
    return { point: start, deleted: true };
  }
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
