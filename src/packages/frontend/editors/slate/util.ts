/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { capitalize, is_whitespace, replace_all } from "@cocalc/util/misc";

// Note: this markdown_escape is based on https://github.com/edwmurph/escape-markdown/blob/master/index.js

const MAP = {
  "*": "\\*",
  "+": "\\+",
  "-": "\\-",
  "#": "\\#",
  "[": "\\[",
  "]": "\\]",
  "|": "\\|",
  _: "\\_",
  "\\": "\\\\",
  "`": "\\`",
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  "\xa0": "&nbsp;", // we do this so that the markdown nbsp's are explicit
  $: "\\$",
} as const;

const WORD_CHAR = /[A-Za-z0-9]/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function isWordChar(ch: string): boolean {
  return WORD_CHAR.test(ch);
}

function isWhitespace(ch: string): boolean {
  return ch === "" || /\s/.test(ch);
}

function escapeEmphasisRuns(
  s: string,
  delim: "*" | "_",
  avoidInWord: boolean
): string {
  const runs: {
    index: number;
    len: number;
    kind: 1 | 2;
    canOpen: boolean;
    canClose: boolean;
  }[] = [];

  for (let i = 0; i < s.length; i++) {
    if (s[i] !== delim) continue;
    if (i > 0 && s[i - 1] === "\\") continue;

    let j = i;
    while (j < s.length && s[j] === delim) j++;

    const prev = i > 0 ? s[i - 1] : "";
    const next = j < s.length ? s[j] : "";
    const prevWhitespace = isWhitespace(prev);
    const nextWhitespace = isWhitespace(next);
    const prevWord = prev !== "" && isWordChar(prev);
    const nextWord = next !== "" && isWordChar(next);
    const prevPunct = prev !== "" && !prevWhitespace && !prevWord;
    const nextPunct = next !== "" && !nextWhitespace && !nextWord;
    let canOpen =
      !nextWhitespace && !(nextPunct && !prevWhitespace && !prevPunct);
    let canClose =
      !prevWhitespace && !(prevPunct && !nextWhitespace && !nextPunct);

    if (avoidInWord && prevWord && nextWord) {
      canOpen = false;
      canClose = false;
    }

    const len = j - i;
    runs.push({
      index: i,
      len,
      kind: len >= 2 ? 2 : 1,
      canOpen,
      canClose,
    });
    i = j - 1;
  }

  if (runs.length === 0) return s;

  const escape = new Set<number>();
  const stack: { 1: number[]; 2: number[] } = { 1: [], 2: [] };

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    if (run.canClose && stack[run.kind].length > 0) {
      const openIndex = stack[run.kind].pop()!;
      const openRun = runs[openIndex];
      for (let k = 0; k < openRun.len; k++) {
        escape.add(openRun.index + k);
      }
      for (let k = 0; k < run.len; k++) {
        escape.add(run.index + k);
      }
      continue;
    }
    if (run.canOpen) {
      stack[run.kind].push(r);
    }
  }

  if (escape.size === 0) return s;

  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (escape.has(i)) {
      out += `\\${s[i]}`;
    } else {
      out += s[i];
    }
  }
  return out;
}

function escapeReferenceDefinitions(s: string): string {
  return s.replace(
    /(^|\n)(\s*)\[(\^?[^\]\n]+)\]:/g,
    (_match, start, ws, label) => `${start}${ws}\\[${label}]:`
  );
}

function escapeTableSeparatorPipes(s: string): string {
  const lines = s.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("|") && TABLE_SEPARATOR.test(line)) {
      lines[i] = line.replace(/\|/g, "\\|");
      changed = true;
    }
  }
  return changed ? lines.join("\n") : s;
}

export function markdownEscape(
  s: string,
  isFirstChild: boolean = false
): string {
  // The 1-character replacements we make in any text.
  s = s.replace(/[\\`<>$]/g, (m) => MAP[m]);
  // Version of the above, but with some keys from the map purposely missing here,
  // since overescaping makes the generated markdown ugly. We still escape
  // enough characters to avoid accidental auto-formatting during collab.
  // s = s.replace(/[\\`<>$&\xa0|]/g, (m) => MAP[m]);

  // Avoid auto-emphasis when the Slate text doesn't carry marks.
  s = escapeEmphasisRuns(s, "*", false);
  s = escapeEmphasisRuns(s, "_", true);

  if (isFirstChild) {
    // Escape three dashes at start of line mod whitespace (which is hr).
    s = s.replace(/^\s*---/, (m) => m.replace("---", "\\-\\-\\-"));

    // Escape # signs at start of line (headers).
    s = s.replace(/^\s*#+/, (m) => replace_all(m, "#", "\\#"));

    // Escape list markers at the start of a line.
    s = s.replace(
      /^(\s*)([*+-])(\s+)/,
      (_, ws, marker, rest) => `${ws}\\${marker}${rest}`
    );
    s = s.replace(
      /^(\s*)(\d+)([.)])(\s+)/,
      (_, ws, digits, marker, rest) => `${ws}${digits}\\${marker}${rest}`
    );
  }

  // Avoid accidental reference definitions and table separators in plain text.
  s = escapeReferenceDefinitions(s);
  s = escapeTableSeparatorPipes(s);

  return s;
}

export function indent(s: string, n: number): string {
  if (n == 0) {
    return s;
  }
  let left = "";
  for (let i = 0; i < n; i++) {
    left += " ";
  }

  // add space at beginning of all non-whitespace lines
  const v = s.split("\n");
  for (let i = 0; i < v.length; i++) {
    if (!is_whitespace(v[i])) {
      v[i] = left + v[i];
    }
  }
  return v.join("\n");
}

/*
li_indent -- indent all but the first line by amount spaces.

NOTE: There are some cases where more than 2 spaces are needed.
For example, here we need 3:

1. one
2. two
   - foo
   - bar
*/
export function li_indent(s: string, amount: number = 2): string {
  const i = s.indexOf("\n");
  if (i != -1 && i != s.length - 1) {
    return s.slice(0, i + 1) + indent(s.slice(i + 1), amount);
  } else {
    return s;
  }
}

// Ensure that s ends in **exactly one** newline.
export function ensure_ends_in_exactly_one_newline(s: string): string {
  if (s[s.length - 1] != "\n") {
    return s + "\n";
  }
  while (s[s.length - 2] == "\n") {
    s = s.slice(0, s.length - 1);
  }
  return s;
}

export function ensure_ends_in_two_newline(s: string): string {
  if (s[s.length - 1] !== "\n") {
    return s + "\n\n";
  } else if (s[s.length - 2] !== "\n") {
    return s + "\n";
  } else {
    return s;
  }
}

export function mark_block(s: string, mark: string): string {
  const v: string[] = [];
  for (const line of s.trim().split("\n")) {
    if (is_whitespace(line)) {
      v.push(mark);
    } else {
      v.push(mark + " " + line);
    }
  }
  return v.join("\n") + "\n\n";
}

function indexOfNonWhitespace(s: string): number {
  // regexp finds where the first non-whitespace starts
  return /\S/.exec(s)?.index ?? -1;
}

function lastIndexOfNonWhitespace(s: string): number {
  // regexp finds where the whitespace starts at the end of the string.
  return (/\s+$/.exec(s)?.index ?? s.length) - 1;
}

export function stripWhitespace(s: string): {
  before: string;
  trimmed: string;
  after: string;
} {
  const i = indexOfNonWhitespace(s);
  const j = lastIndexOfNonWhitespace(s);
  return {
    before: s.slice(0, i),
    trimmed: s.slice(i, j + 1),
    after: s.slice(j + 1),
  };
}

export function markInlineText(
  text: string,
  left: string,
  right?: string // defaults to left if not given
): string {
  // For non-HTML, we have to put the mark *inside* of any
  // whitespace on the outside.
  // See https://www.markdownguide.org/basic-syntax/#bold
  // where it says "... without spaces ...".
  // In particular, `** bold **` does NOT work.
  // This is NOT true for html, of course.
  if (left.indexOf("<") != -1) {
    // html - always has right set.
    return left + text + right;
  }
  const { before, trimmed, after } = stripWhitespace(text);
  if (trimmed.length == 0) {
    // all whitespace, so don't mark it.
    return text;
  }
  return `${before}${left}${trimmed}${right ?? left}${after}`;
}

export function padLeft(s: string, n: number): string {
  while (s.length < n) {
    s = " " + s;
  }
  return s;
}

export function padRight(s: string, n: number): string {
  while (s.length < n) {
    s += " ";
  }
  return s;
}

export function padCenter(s: string, n: number): string {
  while (s.length < n) {
    s = " " + s + " ";
  }
  return s.slice(0, n);
}

export const FOCUSED_COLOR = "#7eb6e2";
export const SELECTED_COLOR = "#1990ff";
/* This focused color is "Jupyter notebook classic" focused cell green. */
export const CODE_FOCUSED_COLOR = "#66bb6a";
export const CODE_FOCUSED_BACKGROUND = "#cfe8fc";
export const DARK_GREY_BORDER = "#cfcfcf";

export function string_to_style(style: string): any {
  const obj: any = {};
  for (const x of style.split(";")) {
    const j = x.indexOf("=");
    if (j == -1) continue;
    let key = x.slice(0, j);
    const i = key.indexOf("-");
    if (i != -1) {
      key = x.slice(0, i) + capitalize(x.slice(i + 1));
    }
    obj[key] = x.slice(j + 1);
  }
  return obj;
}

export const DEFAULT_CHILDREN = [{ text: "" }];

export function removeBlankLines(s: string): string {
  return s.replace(/^\s*\n/gm, "");
}
