// Rejects invisible Unicode control characters in tracked text files:
// bidirectional overrides/isolates (U+202A-U+202E, U+2066-U+2069, the
// "Trojan Source" class), which can make code display differently from how it
// runs, and LINE/PARAGRAPH SEPARATOR (U+2028/U+2029), which many line readers
// treat as line breaks. Write them as escapes (for example "\u2028") instead.
// They tend to arrive by accident, e.g. when an escape is decoded into a raw
// character on its way into a file.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTROLS = new Map([
  [0x2028, "LINE SEPARATOR"],
  [0x2029, "PARAGRAPH SEPARATOR"],
  [0x202a, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202b, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202c, "POP DIRECTIONAL FORMATTING"],
  [0x202d, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202e, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
]);

export function findUnicodeControls(text) {
  const found = [];
  let line = 1;
  let column = 1;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const name = CONTROLS.get(code);
    if (name)
      found.push({
        line,
        column,
        code: `U+${code.toString(16).toUpperCase()}`,
        name,
      });
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return found;
}

export function scanTrackedFiles(root) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  })
    .split("\0")
    .filter(Boolean);
  const problems = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    for (const hit of findUnicodeControls(text))
      problems.push(
        `${file}:${hit.line}:${hit.column} ${hit.code} ${hit.name}`,
      );
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  const problems = scanTrackedFiles(root);
  if (problems.length) {
    console.error(
      `Invisible Unicode control characters found (write them as escapes):\n${problems.join("\n")}`,
    );
    process.exit(1);
  }
  console.log("No invisible Unicode control characters in tracked files.");
}
