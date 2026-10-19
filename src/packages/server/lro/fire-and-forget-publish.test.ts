/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// LRO progress publishes are fire-and-forget, so nothing awaits them. A
// publish that times out (e.g. while a course collect floods the persist
// server) then rejects with nobody listening, and the hub logs it as an
// unhandled rejection. Every `void publishLro...(...)` must end in `.catch(`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..");
const SKIP = new Set(["node_modules", "dist", "dist-ts"]);
const CALL = /\bvoid\s+(publishLroEvent|publishLroSummary)\(/g;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sources(path, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

// Returns the index just past the parenthesis that closes the one at `open`.
function closingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth === 0) return i + 1;
  }
  return text.length;
}

function uncaughtPublishes(text: string): number[] {
  const lines: number[] = [];
  for (const match of text.matchAll(CALL)) {
    const end = closingParen(text, match.index! + match[0].length - 1);
    if (!/^\s*\.catch\(/.test(text.slice(end))) {
      lines.push(text.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

describe("fire-and-forget LRO publishes", () => {
  it("detects a void publish without a catch", () => {
    expect(
      uncaughtPublishes(
        "void publishLroEvent({ a: f(1) });\nvoid publishLroSummary({}).catch(() => {});\n",
      ),
    ).toEqual([1]);
  });

  it("always handle rejection", () => {
    const offenders = sources(ROOT).flatMap((path) =>
      uncaughtPublishes(readFileSync(path, "utf8")).map(
        (line) => `${relative(ROOT, path)}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
