/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import Prism from "prismjs";
import infoToMode from "./info-to-mode";
import { DecoratedRange, Node } from "slate";
import type { CodeBlock } from "./types";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-go";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-python";
import "prismjs/components/prism-r";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-yaml";

type PrismToken = Prism.Token;

export type NormalizedToken = {
  types: string[];
  content: string;
  empty?: boolean;
};

const newlineRe = /\r\n|\r|\n/;

const normalizeEmptyLines = (line: NormalizedToken[]) => {
  if (line.length === 0) {
    line.push({
      types: ["plain"],
      content: "\n",
      empty: true,
    });
  } else if (line.length === 1 && line[0].content === "") {
    line[0].content = "\n";
    line[0].empty = true;
  }
};

const appendTypes = (types: string[], add: string[] | string): string[] => {
  const last = types[types.length - 1];
  if (last === add) return types;
  return types.concat(add);
};

// Copied and adapted from prism-react-renderer.
export const normalizeTokens = (
  tokens: Array<PrismToken | string>
): NormalizedToken[][] => {
  const typeArrStack: string[][] = [[]];
  const tokenArrStack = [tokens];
  const tokenArrIndexStack = [0];
  const tokenArrSizeStack = [tokens.length];

  let i = 0;
  let stackIndex = 0;
  let currentLine: NormalizedToken[] = [];

  const acc = [currentLine];

  while (stackIndex > -1) {
    while (
      (i = tokenArrIndexStack[stackIndex]++) < tokenArrSizeStack[stackIndex]
    ) {
      let content: any;
      let types = typeArrStack[stackIndex];

      const tokenArr = tokenArrStack[stackIndex];
      const token = tokenArr[i];

      if (typeof token === "string") {
        types = stackIndex > 0 ? types : ["plain"];
        content = token;
      } else {
        types = appendTypes(types, token.type);
        if (token.alias) {
          types = appendTypes(types, token.alias);
        }
        content = token.content;
      }

      if (typeof content !== "string") {
        stackIndex++;
        typeArrStack.push(types);
        tokenArrStack.push(content as PrismToken[]);
        tokenArrIndexStack.push(0);
        tokenArrSizeStack.push(content.length);
        continue;
      }

      const splitByNewlines = content.split(newlineRe);
      const newlineCount = splitByNewlines.length;

      currentLine.push({ types, content: splitByNewlines[0] });

      for (let j = 1; j < newlineCount; j++) {
        normalizeEmptyLines(currentLine);
        acc.push((currentLine = []));
        currentLine.push({ types, content: splitByNewlines[j] });
      }
    }

    stackIndex--;
    typeArrStack.pop();
    tokenArrStack.pop();
    tokenArrIndexStack.pop();
    tokenArrSizeStack.pop();
  }

  normalizeEmptyLines(currentLine);
  return acc;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  html: "markup",
  htm: "markup",
  xhtml: "markup",
  xml: "markup",
  svg: "markup",
  htmlmixed: "markup",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  rb: "ruby",
  cxx: "cpp",
  cc: "cpp",
  cpp: "cpp",
  rs: "rust",
  yml: "yaml",
  md: "markdown",
  json: "json",
  text: "plain",
  plaintext: "plain",
};

export function normalizePrismLanguage(info: string | undefined): string {
  const raw = (info ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (!raw) return "plain";
  return LANGUAGE_ALIASES[raw] ?? raw;
}

function getPrismLanguage(info: string | undefined, text?: string): string {
  const mode = infoToMode(info, { value: text });
  return normalizePrismLanguage(mode);
}

export function getPrismGrammar(
  info: string | undefined,
  text?: string,
): Prism.Grammar | null {
  const lang = getPrismLanguage(info, text);
  if (lang === "plain") return null;
  return Prism.languages[lang] ?? null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function highlightCodeHtml(text: string, info?: string): string {
  const lang = getPrismLanguage(info, text);
  const grammar = getPrismGrammar(info, text);
  if (!grammar) {
    return escapeHtml(text);
  }
  return Prism.highlight(text, grammar, lang);
}

export function buildCodeBlockDecorations(
  block: CodeBlock,
  blockPath: number[],
  infoOverride?: string,
): DecoratedRange[][] {
  const text = block.children.map((line) => Node.string(line)).join("\n");
  const info = infoOverride ?? block.info;
  const grammar = getPrismGrammar(info, text);
  if (!grammar) {
    return [];
  }
  const tokens = Prism.tokenize(text, grammar);
  const normalizedTokens = normalizeTokens(tokens);
  const decorations: DecoratedRange[][] = [];

  for (let lineIndex = 0; lineIndex < normalizedTokens.length; lineIndex++) {
    const tokensForLine = normalizedTokens[lineIndex];
    let start = 0;
    const ranges: DecoratedRange[] = [];
    for (const token of tokensForLine) {
      const length = token.content.length;
      if (!length) continue;
      const end = start + length;
      const path = [...blockPath, lineIndex, 0];
      ranges.push({
        anchor: { path, offset: start },
        focus: { path, offset: end },
        token: true,
        ...Object.fromEntries(token.types.map((type) => [type, true])),
      } as DecoratedRange);
      start = end;
    }
    decorations[lineIndex] = ranges;
  }

  return decorations;
}
