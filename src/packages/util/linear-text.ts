/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Linear-time text helpers that replace regular expressions which are
super-linear on adversarial input.

An unanchored pattern such as /\/+$/ or /<[^>]+>/g is retried from every
start position, so a long run of matching characters that fails at the end
costs quadratic time, and patterns built from user wildcards ("a%a%a%b")
cost far more. Project hosts serve many users from one Node event loop, so a
single slow match stalls every project on the host. Code that runs on a host
should prefer these explicit scans.
*/

function trailingStart(
  text: string,
  chars: string | ((char: string) => boolean),
): number {
  const matches =
    typeof chars === "string" ? (char: string) => chars.includes(char) : chars;
  let end = text.length;
  while (end > 0 && matches(text[end - 1])) {
    end -= 1;
  }
  return end;
}

function leadingEnd(text: string, chars: string): number {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) {
    start += 1;
  }
  return start;
}

// Remove trailing characters that are in chars, e.g. ("a?!", "?!") -> "a",
// or that satisfy a predicate.
export function trimTrailingChars(
  text: string,
  chars: string | ((char: string) => boolean),
): string {
  return text.slice(0, trailingStart(text, chars));
}

// Number of trailing characters from chars.
export function countTrailingChars(text: string, chars: string): number {
  return text.length - trailingStart(text, chars);
}

// Number of leading characters from chars.
export function countLeadingChars(text: string, chars: string): number {
  return leadingEnd(text, chars);
}

// text.replace(/\/+$/, "")
export function trimTrailingSlashes(text: string): string {
  return trimTrailingChars(text, "/");
}

// text.replace(/^\/+|\/+$/g, "")
export function trimSlashes(text: string): string {
  const start = leadingEnd(text, "/");
  return start === text.length
    ? ""
    : text.slice(start, trailingStart(text, "/"));
}

// Lower-case only A-Z, as a non-Unicode /i regular expression folds case for
// ASCII text; unlike toLowerCase it never changes the length.
export function asciiLowerCase(text: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 65 && code <= 90) {
      result += text.slice(from, i) + String.fromCharCode(code + 32);
      from = i + 1;
    }
  }
  return result + text.slice(from);
}

// Whether a UTF-16 code unit is matched by the regular expression \s, which
// is exactly the set String.prototype.trim removes.
export function isRegExpWhitespace(char: string): boolean {
  return char.length === 1 && char.trim() === "";
}

// text.replace(/<[^>]+>/g, replacement), or /<[^>]*>/g with allowEmpty.
export function replaceAngleTags(
  text: string,
  replacement: string,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): string {
  let result = "";
  let from = 0;
  let search = 0;
  while (search < text.length) {
    const open = text.indexOf("<", search);
    if (open < 0) break;
    const close = text.indexOf(">", open + 1);
    // No later "<" can be closed either, so there are no more tags.
    if (close < 0) break;
    if (close === open + 1 && !allowEmpty) {
      search = close;
      continue;
    }
    result += text.slice(from, open) + replacement;
    from = search = close + 1;
  }
  return result + text.slice(from);
}

// The trimmed body of the first ``` fence, after an optional tag such as
// "json" (ASCII case-insensitive), as
//   text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]
// captures it; that pattern takes cubic time on text with many fences.
export function firstCodeFenceBody(text: string, tag = ""): string | undefined {
  const open = text.indexOf("```");
  if (open < 0) return;
  const close = text.indexOf("```", open + 3);
  if (close < 0) return;
  let start = open + 3;
  if (
    tag &&
    asciiLowerCase(text.slice(start, start + tag.length)) ===
      asciiLowerCase(tag)
  ) {
    start += tag.length;
  }
  // A tag without backticks always ends before the closing fence.
  return text.slice(Math.min(start, close), close).trim();
}

// A wildcard pattern for matchWildcard: literal code units, a single
// arbitrary code unit, or a run of zero or more code units, optionally
// excluding "/" (a glob "*" within one path segment).
export type WildcardToken =
  | { kind: "literal"; char: string }
  | { kind: "any" }
  | { kind: "run"; crossSlash: boolean };

// Canonicalize a code unit the way a non-Unicode /i regular expression does
// (ECMAScript Canonicalize): upper-case it, unless that would change its
// length or turn a non-ASCII character into an ASCII one.
function canonicalize(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 128) {
    return code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : char;
  }
  const upper = char.toUpperCase();
  if (upper.length !== 1 || upper.charCodeAt(0) < 128) {
    return char;
  }
  return upper;
}

// Whether the whole text matches the pattern. This simulates the pattern's
// automaton, keeping the list of pattern positions consistent with the text
// read so far, so it takes at most O(text.length * tokens.length) time however
// many runs the pattern has (and about linear time for typical patterns). A backtracking regular expression built from the
// same pattern takes time exponential in the number of runs.
export function matchWildcard(
  tokens: readonly WildcardToken[],
  text: string,
  { ignoreCase = false }: { ignoreCase?: boolean } = {},
): boolean {
  const size = tokens.length;
  const literals = tokens.map((token) =>
    token.kind !== "literal"
      ? ""
      : ignoreCase
        ? canonicalize(token.char)
        : token.char,
  );
  // addedAt[i] is the last step at which position i became active.
  const addedAt = new Int32Array(size + 1).fill(-1);
  // Activate a position and, since runs match the empty string, every
  // position reachable from it by skipping runs.
  const add = (list: number[], position: number, step: number) => {
    while (addedAt[position] !== step) {
      addedAt[position] = step;
      list.push(position);
      if (position === size || tokens[position].kind !== "run") return;
      position += 1;
    }
  };
  let active: number[] = [];
  add(active, 0, 0);
  for (let j = 0; j < text.length; j++) {
    const char = text[j];
    const folded = ignoreCase ? canonicalize(char) : char;
    let next: number[] = [];
    let crossingRun = -1;
    for (const position of active) {
      if (position === size) continue;
      const token = tokens[position];
      if (token.kind === "run") {
        if (token.crossSlash || char !== "/") {
          add(next, position, j + 1);
          if (token.crossSlash) {
            crossingRun = Math.max(crossingRun, position);
          }
        }
      } else if (token.kind === "any" || literals[position] === folded) {
        add(next, position + 1, j + 1);
      }
    }
    if (next.length === 0) return false;
    // An active run that matches anything dominates every earlier position:
    // a match from there must pass through the run, which can absorb the
    // same text. Dropping them keeps "%a%a%a" patterns linear.
    if (crossingRun > 0) {
      next = next.filter((position) => position >= crossingRun);
    }
    active = next;
  }
  return addedAt[size] === text.length;
}
