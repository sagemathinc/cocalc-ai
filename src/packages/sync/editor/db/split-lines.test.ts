import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitLinesKeepingNewlines } from "./merge3";

describe("splitLinesKeepingNewlines", () => {
  it("matches split(/(?<=\\n)/) exactly", () => {
    const cases = ["", "a", "a\n", "a\nb", "\n", "\n\n", "a\n\nb\n", "x\r\ny"];
    // Plus random strings over a small alphabet, so newline runs, leading and
    // trailing newlines all occur.
    let seed = 1;
    const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let n = 0; n < 500; n++) {
      let s = "";
      const len = Math.floor(rand() * 12);
      for (let i = 0; i < len; i++) s += "ab\n"[Math.floor(rand() * 3)];
      cases.push(s);
    }
    for (const s of cases) {
      expect(splitLinesKeepingNewlines(s)).toEqual(s.split(/(?<=\n)/));
    }
  });
});

// Safari before 16.4 cannot parse a lookbehind ("invalid group specifier
// name"), which makes the whole bundle chunk containing it fail to load. The
// sync package runs in browsers, so keep lookbehinds out of its sources.
describe("browser compatibility", () => {
  it("has no lookbehind regular expressions in sync sources", () => {
    const root = join(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "dist") continue;
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (line.trim().startsWith("//")) return;
              if (/\(\?<[=!]/.test(line)) offenders.push(`${p}:${i + 1}`);
            });
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
