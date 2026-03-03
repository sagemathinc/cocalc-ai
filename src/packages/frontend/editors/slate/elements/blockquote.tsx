/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mark_block } from "../util";
import { register, SlateElement } from "./register";
import { Descendant, Element as SlateNodeElement, Text } from "slate";

export interface BlockQuote extends SlateElement {
  type: "blockquote";
}

const Element = ({ attributes, children }) => {
  return <blockquote {...attributes}>{children}</blockquote>;
};

register({
  slateType: "blockquote",

  fromSlate: ({ children }) => mark_block(children, ">"),

  Element,
  StaticElement: Element,

  toSlate: ({ type, children }) => {
    return { type, children: normalizeParsedQuoteChildren(children) };
  },

  rules: {
    autoFocus: true,
    autoAdvance: false,
  },
});

function normalizeParsedQuoteChildren(children: Descendant[]): Descendant[] {
  const normalized: Descendant[] = [];
  for (const child of children) {
    if (
      SlateNodeElement.isElement(child) &&
      child.type === "paragraph" &&
      Array.isArray(child.children)
    ) {
      const lines = splitParagraphLines(child.children as Descendant[]);
      const hasBlankLine = lines.some((line) => isLineEmpty(line));
      if (hasBlankLine) {
        normalized.push(...linesToParagraphs(lines));
        continue;
      }
    }
    normalized.push(child);
  }
  return normalized;
}

function splitParagraphLines(children: Descendant[]): Descendant[][] {
  const lines: Descendant[][] = [[]];
  for (const child of children) {
    if (SlateNodeElement.isElement(child) && child.type === "softbreak") {
      lines.push([]);
      continue;
    }
    lines[lines.length - 1].push(child);
  }
  return lines;
}

function linesToParagraphs(lines: Descendant[][]): Descendant[] {
  const paragraphs: Descendant[] = [];
  let run: Descendant[][] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const children: Descendant[] = [];
    run.forEach((line, i) => {
      if (i > 0) {
        children.push({
          type: "softbreak",
          isInline: true,
          isVoid: true,
          children: [{ text: "" }],
        } as any);
      }
      children.push(...line);
    });
    paragraphs.push({
      type: "paragraph",
      blank: false,
      children: children.length > 0 ? children : [{ text: "" }],
    } as any);
    run = [];
  };

  for (const line of lines) {
    if (isLineEmpty(line)) {
      flushRun();
      paragraphs.push({
        type: "paragraph",
        blank: true,
        children: [{ text: "" }],
      } as any);
      continue;
    }
    run.push(line);
  }
  flushRun();
  return paragraphs;
}

function isLineEmpty(line: Descendant[]): boolean {
  if (line.length === 0) return true;
  return line.every((n) => Text.isText(n) && n.text === "");
}
