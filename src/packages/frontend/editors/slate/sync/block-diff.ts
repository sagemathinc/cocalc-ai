/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Descendant, Element, Node, Text } from "slate";
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

