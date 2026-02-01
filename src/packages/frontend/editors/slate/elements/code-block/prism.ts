/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import Prism from "prismjs";
import infoToMode from "./info-to-mode";
import { DecoratedRange, Node } from "slate";
import type { CodeBlock } from "./types";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-ada";
import "prismjs/components/prism-c";
import "prismjs/components/prism-clojure";
import "prismjs/components/prism-cobol";
import "prismjs/components/prism-coffeescript";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-csharp";
import "prismjs/components/prism-css";
import "prismjs/components/prism-diff";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-eiffel";
import "prismjs/components/prism-elm";
import "prismjs/components/prism-erlang";
import "prismjs/components/prism-fortran";
import "prismjs/components/prism-go";
import "prismjs/components/prism-haskell";
import "prismjs/components/prism-ini";
import "prismjs/components/prism-java";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-julia";
import "prismjs/components/prism-latex";
import "prismjs/components/prism-livescript";
import "prismjs/components/prism-lua";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-matlab";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-nasm";
import "prismjs/components/prism-nginx";
import "prismjs/components/prism-ocaml";
import "prismjs/components/prism-parigp";
import "prismjs/components/prism-perl";
import "prismjs/components/prism-php";
import "prismjs/components/prism-python";
import "prismjs/components/prism-r";
import "prismjs/components/prism-rest";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-scala";
import "prismjs/components/prism-scheme";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-verilog";
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
  ada: "ada",
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
  latex: "latex",
  stex: "latex",
  stex2: "latex",
};

const MODE_ALIASES: Record<string, string> = {
  ada: "ada",
  "application/typescript": "typescript",
  "application/xml-dtd": "markup",
  coffeescript: "coffeescript",
  css: "css",
  ecl: "plain",
  htmlmixed: "markup",
  javascript: "javascript",
  jsx: "jsx",
  lua: "lua",
  nginx: "nginx",
  pegjs: "javascript",
  php: "php",
  python: "python",
  r: "r",
  rmd: "markdown",
  rnw: "latex",
  rst: "rest",
  rtex: "latex",
  shell: "bash",
  stex: "latex",
  stex2: "latex",
  text: "plain",
  "text/cjsx": "coffeescript",
  "text/pari": "parigp",
  "text/typescript-jsx": "tsx",
  "text/x-c": "c",
  "text/x-c++hdr": "cpp",
  "text/x-c++src": "cpp",
  "text/x-clojure": "clojure",
  "text/x-cobol": "cobol",
  "text/x-csharp": "csharp",
  "text/x-diff": "diff",
  "text/x-eiffel": "eiffel",
  "text/x-elm": "elm",
  "text/x-erlang": "erlang",
  "text/x-fortran": "fortran",
  "text/x-gas": "nasm",
  "text/x-go": "go",
  "text/x-haskell": "haskell",
  "text/x-ini": "ini",
  "text/x-java": "java",
  "text/x-julia": "julia",
  "text/x-livescript": "livescript",
  "text/x-ocaml": "ocaml",
  "text/x-octave": "matlab",
  "text/x-perl": "perl",
  "text/x-ruby": "ruby",
  "text/x-rustsrc": "rust",
  "text/x-scala": "scala",
  "text/x-scheme": "scheme",
  "text/x-sql": "sql",
  "text/x-toml": "toml",
  verilog: "verilog",
  xml: "markup",
  "yaml-frontmatter": "markdown",
};

const CODE_BLOCK_TOKEN_CACHE_LIMIT = 500;
const codeBlockTokenCache = new Map<string, NormalizedToken[][]>();

function getCachedNormalizedTokens(key: string): NormalizedToken[][] | null {
  const cached = codeBlockTokenCache.get(key);
  if (!cached) return null;
  codeBlockTokenCache.delete(key);
  codeBlockTokenCache.set(key, cached);
  return cached;
}

function setCachedNormalizedTokens(
  key: string,
  tokens: NormalizedToken[][],
): void {
  if (codeBlockTokenCache.has(key)) {
    codeBlockTokenCache.delete(key);
  }
  codeBlockTokenCache.set(key, tokens);
  if (codeBlockTokenCache.size > CODE_BLOCK_TOKEN_CACHE_LIMIT) {
    const oldestKey = codeBlockTokenCache.keys().next().value as string | undefined;
    if (oldestKey != null) {
      codeBlockTokenCache.delete(oldestKey);
    }
  }
}

export function normalizePrismLanguage(info: string | undefined): string {
  const raw = (info ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (!raw) return "plain";
  const direct = MODE_ALIASES[raw];
  if (direct) return direct;
  const stripped = raw.replace(/^(text|application)\//, "");
  const strippedAlias = MODE_ALIASES[stripped];
  if (strippedAlias) return strippedAlias;
  if (raw.startsWith("text/x-")) {
    const trimmed = raw.replace(/^text\/x-/, "");
    const trimmedAlias = MODE_ALIASES[trimmed];
    if (trimmedAlias) return trimmedAlias;
  }
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
  if (typeof window !== "undefined" && (window as any).COCALC_SLATE_DISABLE_PRISM) {
    return [];
  }
  const text = block.children.map((line) => Node.string(line)).join("\n");
  const info = infoOverride ?? block.info;
  const lang = getPrismLanguage(info, text);
  if (lang === "plain") return [];
  const grammar = Prism.languages[lang] ?? null;
  if (!grammar) return [];
  const cacheKey = `${lang}\u0000${text}`;
  const cached = getCachedNormalizedTokens(cacheKey);
  if (!cached && typeof window !== "undefined" && (window as any).__slateDebugLog) {
    // eslint-disable-next-line no-console
    console.log("[slate-code] cache miss", { lang, chars: text.length });
  }
  const normalizedTokens =
    cached ??
    (() => {
      const tokens = Prism.tokenize(text, grammar);
      const normalized = normalizeTokens(tokens);
      setCachedNormalizedTokens(cacheKey, normalized);
      return normalized;
    })();
  const decorations: DecoratedRange[][] = [];

  for (let lineIndex = 0; lineIndex < normalizedTokens.length; lineIndex++) {
    const tokensForLine = normalizedTokens[lineIndex];
    let start = 0;
    const ranges: DecoratedRange[] = [];
    for (const token of tokensForLine) {
      const length = token.content.length;
      if (token.empty) {
        // Empty lines have no text in the Slate node; don't emit decorations
        // with offsets past the line length.
        continue;
      }
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
