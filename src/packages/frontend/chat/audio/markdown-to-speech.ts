/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const parser = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
});

function inlineText(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        parts.push(token.content);
        break;
      case "code_inline":
        parts.push(`code ${token.content}`);
        break;
      case "softbreak":
      case "hardbreak":
        parts.push(". ");
        break;
      case "image":
        break;
      default:
        if (token.children?.length) parts.push(inlineText(token.children));
    }
  }
  return parts.join("");
}

export function markdownToSpeechText(markdown: string): string {
  const parts: string[] = [];
  const orderedLists: number[] = [];
  for (const token of parser.parse(markdown ?? "", {})) {
    if (token.type === "fence" || token.type === "code_block") {
      const code = token.content.trim();
      parts.push(
        code.length > 0 && code.length <= 160
          ? `Code: ${code}`
          : "Code block omitted.",
      );
      continue;
    }
    if (token.type === "ordered_list_open") {
      orderedLists.push(Number(token.attrGet("start")) || 1);
      continue;
    }
    if (token.type === "ordered_list_close") {
      orderedLists.pop();
      continue;
    }
    if (token.type === "list_item_open") {
      const index = orderedLists.length - 1;
      if (index >= 0) {
        parts.push(`Item ${orderedLists[index]}.`);
        orderedLists[index] += 1;
      } else {
        parts.push("Item.");
      }
      continue;
    }
    if (token.type === "blockquote_open") parts.push("Quote.");
    if (token.type === "inline") parts.push(inlineText(token.children ?? []));
  }
  return parts
    .join("\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSpeechText(text: string, maxCharacters = 3_800): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const chunks: string[] = [];
  const paragraphs = clean.split(/\n{2,}/);
  let current = "";
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxCharacters) {
      current = candidate;
      continue;
    }
    push(current);
    current = "";
    const sentences = paragraph.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [paragraph];
    for (const sentence of sentences) {
      const value = sentence.trim();
      if (value.length > maxCharacters) {
        push(current);
        current = "";
        for (let i = 0; i < value.length; i += maxCharacters) {
          push(value.slice(i, i + maxCharacters));
        }
        continue;
      }
      const next = current ? `${current} ${value}` : value;
      if (next.length > maxCharacters) {
        push(current);
        current = value;
      } else {
        current = next;
      }
    }
  }
  push(current);
  return chunks;
}
