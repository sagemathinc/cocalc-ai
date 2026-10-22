import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { setNoCheck } from "./ci-tsc-emit-only.mjs";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(SRC_ROOT, "packages", "node_modules", ".bin", "tsc");

test("the real base tsconfig is plain JSON the script can edit", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-emit-only-"));
  try {
    const copy = join(dir, "tsconfig.json");
    const original = readFileSync(
      join(SRC_ROOT, "packages", "tsconfig.json"),
      "utf8",
    );
    writeFileSync(copy, original);
    const config = setNoCheck(copy);
    assert.equal(config.compilerOptions.noCheck, true);
    // Everything else is kept.
    const before = JSON.parse(original);
    const after = JSON.parse(readFileSync(copy, "utf8"));
    delete after.compilerOptions.noCheck;
    assert.deepEqual(after, before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a JSONC tsconfig is refused, not mangled", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-emit-only-"));
  try {
    const path = join(dir, "tsconfig.json");
    const text = '{\n  // a comment\n  "compilerOptions": {}\n}\n';
    writeFileSync(path, text);
    assert.throws(() => setNoCheck(path), /is not plain JSON/);
    assert.equal(readFileSync(path, "utf8"), text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The property the CI split relies on: an extending project emits without
// errors, and a later plain build of the same tree still reports them.
test("a project extending it emits despite a type error, which tsc without the override reports", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-emit-only-"));
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          module: "commonjs",
          target: "es2020",
          types: [],
        },
      }),
    );
    mkdirSync(join(dir, "pkg"));
    writeFileSync(
      join(dir, "pkg", "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { outDir: "dist", rootDir: "." },
        include: ["*.ts"],
      }),
    );
    writeFileSync(
      join(dir, "pkg", "index.ts"),
      'export const n: number = "not a number";\n',
    );
    setNoCheck(join(dir, "tsconfig.json"));
    execFileSync(TSC, ["--build", join(dir, "pkg")], { stdio: "pipe" });
    assert.match(
      readFileSync(join(dir, "pkg", "dist", "index.js"), "utf8"),
      /not a number/,
    );
    // As in the typecheck job: the same tsc, without the override.
    const result = (() => {
      try {
        execFileSync(TSC, ["--build", join(dir, "pkg"), "--noCheck", "false"], {
          stdio: "pipe",
          encoding: "utf8",
        });
        return "";
      } catch (err) {
        return `${err.stdout}`;
      }
    })();
    assert.match(result, /TS2322/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
