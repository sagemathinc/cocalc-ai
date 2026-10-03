import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  findUnicodeControls,
  scanTrackedFiles,
} from "./check-unicode-controls.mjs";

const c = (code) => String.fromCharCode(code);

test("finds separators and bidi controls with their positions", () => {
  const text = `ok\nconst a = "x${c(0x2028)}y";\nlet s = "${c(0x202e)}abc${c(0x2066)}";`;
  assert.deepEqual(
    findUnicodeControls(text).map(({ line, column, code }) => [
      line,
      column,
      code,
    ]),
    [
      [2, 13, "U+2028"],
      [3, 10, "U+202E"],
      [3, 14, "U+2066"],
    ],
  );
});

test("accepts escapes and ordinary non-ASCII text", () => {
  const escapes = "const re = /[" + "\\" + "u2028" + "\\" + "u202e]/;";
  assert.deepEqual(findUnicodeControls(`${escapes} // é 😀 日本 עברית`), []);
});

test("the repository contains none", () => {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
  assert.deepEqual(scanTrackedFiles(root), []);
});
