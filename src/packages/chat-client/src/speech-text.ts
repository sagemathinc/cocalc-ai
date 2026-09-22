/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { parse_markdown } from "@cocalc/util/markdown/parse";
import type Token from "markdown-it/lib/token";

function inlineText(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "emoji":
      case "text":
        parts.push(token.content);
        break;
      case "code_inline":
        parts.push(`code ${token.content}`);
        break;
      case "softbreak":
        parts.push(" ");
        break;
      case "hardbreak":
        parts.push("\n");
        break;
      case "math_inline":
      case "math_inline_double":
        // Retain TeX rather than guessing mathematical meaning. A dedicated
        // math-to-speech adapter can replace this without reparsing Markdown.
        parts.push(`$${token.content}$`);
        break;
      case "hashtag":
        parts.push(`#${token.content}`);
        break;
      case "mention":
        parts.push((token as Token & { name: string }).name);
        break;
      case "agent-mention":
        parts.push(
          (token as Token & { reference: { name: string } }).reference.name,
        );
        break;
      case "checkbox_input":
        parts.push(
          token.attrGet("checked") === "true"
            ? "Completed: "
            : "Not completed: ",
        );
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
  const lists: (number | null)[] = [];
  let headers: string[] = [];
  let row: string[] | undefined;
  let headerRow = false;
  for (const token of parse_markdown(markdown ?? "").tokens) {
    if (token.type === "table_open") {
      headers = [];
      continue;
    }
    if (token.type === "thead_open") {
      headerRow = true;
      continue;
    }
    if (token.type === "thead_close") {
      headerRow = false;
      continue;
    }
    if (token.type === "tr_open") {
      row = [];
      continue;
    }
    if (token.type === "tr_close") {
      if (headerRow) headers = row ?? [];
      else
        parts.push(
          (row ?? [])
            .map(
              (value, i) =>
                `${headers[i] || `Column ${i + 1}`}: ${value || "empty"}`,
            )
            .join(". ") + ".",
        );
      row = undefined;
      continue;
    }
    if (token.type === "inline" && row) {
      row.push(inlineText(token.children ?? []));
      continue;
    }
    if (token.type === "html_block") {
      // Keep content audible until the shared document converter provides
      // semantic HTML nodes. Dropping this token would drop entire answers.
      parts.push(token.content.trim());
      continue;
    }
    if (token.type === "math_block") {
      parts.push(`Formula: ${token.content.trim()}`);
      continue;
    }

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
      lists.push(Number(token.attrGet("start")) || 1);
      continue;
    }
    if (token.type === "bullet_list_open") {
      lists.push(null);
      continue;
    }
    if (
      token.type === "ordered_list_close" ||
      token.type === "bullet_list_close"
    ) {
      lists.pop();
      continue;
    }
    if (token.type === "list_item_open") {
      const index = lists.length - 1;
      const number = lists[index];
      if (number != null) {
        parts.push(`Item ${number}.`);
        lists[index] = number + 1;
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
  if (!Number.isFinite(maxCharacters) || maxCharacters < 1)
    throw new Error("Speech chunk size must be positive.");
  maxCharacters = Math.floor(maxCharacters);
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
