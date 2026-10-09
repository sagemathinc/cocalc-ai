/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  asciiLowerCase,
  countLeadingChars,
  firstCodeFenceBody,
  countTrailingChars,
  isRegExpWhitespace,
  matchWildcard,
  replaceAngleTags,
  trimSlashes,
  trimTrailingChars,
  trimTrailingSlashes,
  type WildcardToken,
} from "./linear-text";

// Deterministic pseudo-random strings over a small alphabet, so the
// interesting cases (runs, near misses, delimiters) are common.
function randomStrings(
  alphabet: readonly string[],
  count: number,
  maxPieces = 12,
): string[] {
  let seed = 20261009;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const result: string[] = [];
  for (let i = 0; i < count; i++) {
    let text = "";
    const n = Math.floor(random() * (maxPieces + 1));
    for (let j = 0; j < n; j++) {
      text += alphabet[Math.floor(random() * alphabet.length)];
    }
    result.push(text);
  }
  return result;
}

function elapsed(f: () => void): number {
  const started = Date.now();
  f();
  return Date.now() - started;
}

describe("trimming", () => {
  const texts = randomStrings(["/", "a", " ", "\n", "?", "!", "."], 5000);

  it("matches the trailing and leading patterns", () => {
    for (const text of texts) {
      expect(trimTrailingSlashes(text)).toBe(text.replace(/\/+$/, ""));
      expect(trimSlashes(text)).toBe(text.replace(/^\/+|\/+$/g, ""));
      expect(trimTrailingChars(text, ".!?")).toBe(text.replace(/[.!?]+$/, ""));
      expect(countTrailingChars(text, "\n")).toBe(
        text.match(/\n*$/)![0].length,
      );
      expect(countLeadingChars(text, "\n")).toBe(text.match(/^\n*/)![0].length);
      expect(
        trimTrailingChars(
          text,
          (char) => char === "?" || isRegExpWhitespace(char),
        ),
      ).toBe(text.replace(/[\s?]+$/, ""));
    }
  });

  it("is linear on long runs that fail at the end", () => {
    const slashes = `${"/".repeat(2_000_000)}x`;
    expect(elapsed(() => trimTrailingSlashes(slashes))).toBeLessThan(500);
    expect(elapsed(() => trimSlashes(slashes))).toBeLessThan(500);
    expect(trimSlashes(slashes)).toBe("x");
  });
});

describe("isRegExpWhitespace", () => {
  it("agrees with \\s on every UTF-16 code unit", () => {
    const mismatches: number[] = [];
    for (let code = 0; code < 0x10000; code++) {
      const char = String.fromCharCode(code);
      if (isRegExpWhitespace(char) !== /\s/.test(char)) {
        mismatches.push(code);
      }
    }
    expect(mismatches).toEqual([]);
    // trimEnd removes exactly the same set, so it replaces /\s+$/.
    for (const text of randomStrings([" ", " ", "﻿", "a"], 2000)) {
      expect(text.trimEnd()).toBe(text.replace(/\s+$/, ""));
    }
  });
});

describe("asciiLowerCase", () => {
  it("lower-cases A-Z only and keeps the length", () => {
    expect(asciiLowerCase("AbCİKZ")).toBe("abcİKz");
  });
});

describe("replaceAngleTags", () => {
  const texts = randomStrings(["<", ">", "a", "<>", " ", "<b>"], 10000);

  it("matches /<[^>]+>/g and /<[^>]*>/g", () => {
    for (const text of texts) {
      expect(replaceAngleTags(text, " ")).toBe(text.replace(/<[^>]+>/g, " "));
      expect(replaceAngleTags(text, "#", { allowEmpty: true })).toBe(
        text.replace(/<[^>]*>/g, "#"),
      );
    }
  });

  it("is linear on many unclosed tags", () => {
    const text = "<".repeat(2_000_000);
    expect(elapsed(() => replaceAngleTags(text, " "))).toBeLessThan(500);
    const mixed = "<a".repeat(500_000) + ">";
    expect(replaceAngleTags(mixed, " ")).toBe(" ");
  });
});

describe("matchWildcard", () => {
  function escape(char: string): string {
    return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char;
  }

  // The regular expression the wildcard tokens replace, with runs and "any"
  // matching every code unit.
  function toRegExp(tokens: WildcardToken[], flags: string): RegExp {
    let source = "^";
    for (const token of tokens) {
      if (token.kind === "run") {
        source += token.crossSlash ? "[^]*" : "[^/]*";
      } else if (token.kind === "any") {
        source += "[^]";
      } else {
        source += escape(token.char);
      }
    }
    return new RegExp(`${source}$`, flags);
  }

  function parse(pattern: string): WildcardToken[] {
    const tokens: WildcardToken[] = [];
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i] === "*") {
        const crossSlash = pattern[i + 1] === "*";
        if (crossSlash) i++;
        tokens.push({ kind: "run", crossSlash });
      } else if (pattern[i] === "?") {
        tokens.push({ kind: "any" });
      } else {
        tokens.push({ kind: "literal", char: pattern[i] });
      }
    }
    return tokens;
  }

  it("matches what the equivalent regular expression matches", () => {
    const patterns = randomStrings(["*", "**", "?", "a", "b", "/"], 600, 7);
    const texts = randomStrings(["a", "b", "/", "ab", "\n"], 60, 8);
    for (const pattern of patterns) {
      const tokens = parse(pattern);
      const re = toRegExp(tokens, "");
      for (const text of texts) {
        expect([pattern, text, matchWildcard(tokens, text)]).toEqual([
          pattern,
          text,
          re.test(text),
        ]);
      }
    }
  });

  it("folds case exactly like a non-Unicode /i regular expression", () => {
    // Including characters whose case mappings cross into ASCII or change
    // length: long s, Kelvin sign, dotted capital I, sharp s.
    const chars = ["a", "A", "s", "S", "k", "K", "i", "I"];
    const special = ["ſ", "K", "İ", "ı", "ß", "é"];
    const all = [...chars, ...special, "É"];
    for (const p of all) {
      for (const t of all) {
        const tokens: WildcardToken[] = [{ kind: "literal", char: p }];
        expect([p, t, matchWildcard(tokens, t, { ignoreCase: true })]).toEqual([
          p,
          t,
          toRegExp(tokens, "i").test(t),
        ]);
      }
    }
  });

  it("stays fast on patterns with many runs", () => {
    const text = "a".repeat(4096);
    const like = parse(`${"a**".repeat(128)}b`);
    const glob = parse(`${"*a".repeat(128)}b`);
    expect(
      elapsed(() => {
        expect(matchWildcard(like, text)).toBe(false);
        expect(matchWildcard(glob, text)).toBe(false);
        expect(matchWildcard(parse(`${"a**".repeat(128)}a`), text)).toBe(true);
      }),
    ).toBeLessThan(1000);
  });
});

describe("firstCodeFenceBody", () => {
  it("captures what the fence pattern captures", () => {
    const pieces = [
      "```",
      "``",
      "`",
      "json",
      "JSON",
      "jso",
      " ",
      "\n",
      "a",
      "{}",
    ];
    for (const text of randomStrings(pieces, 20000)) {
      expect([text, firstCodeFenceBody(text, "json")]).toEqual([
        text,
        text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1],
      ]);
    }
  });

  it("is linear on many unterminated fences", () => {
    // Cubic for the pattern: 20 s at 4,000 characters.
    const text = "```" + " ".repeat(1_000_000);
    expect(elapsed(() => firstCodeFenceBody(text, "json"))).toBeLessThan(500);
    const fences = "``` ".repeat(250_000);
    expect(elapsed(() => firstCodeFenceBody(fences, "json"))).toBeLessThan(500);
  });
});
