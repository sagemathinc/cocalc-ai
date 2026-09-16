import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isJestCacheInput, jestCacheKey } from "./ci-jest-cache-key.mjs";

test("selects workspace compiler and dependency inputs, not installed output", () => {
  for (const path of [
    "src/packages/pnpm-lock.yaml",
    "src/packages/tsconfig.json",
    "src/packages/pnpm-workspace.yaml",
    "src/packages/frontend/tsconfig.test.json",
    "src/packages/apps/notebook/jest.config.cjs",
    "src/packages/apps/notebook/jest.config.json",
    "src/packages/server/babel.config.js",
    "src/packages/server/package.json",
  ])
    assert.equal(isJestCacheInput(path), true, path);
  for (const path of [
    "src/packages/node_modules/example/jest.config.js",
    "src/packages/server/node_modules/example/package.json",
    "src/packages/server/dist/tsconfig.json",
    "src/packages/server/example.test.ts",
    "docs/package.json",
  ])
    assert.equal(isJestCacheInput(path), false, path);
});

test("cache key responds to tracked changes but ignores generated and untracked files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-cache-key-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  git("init", "--quiet");
  write("src/packages/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  write("src/packages/server/tsconfig.test.json", "{}");
  git("add", ".");
  const original = jestCacheKey(root);
  assert.match(original, /^[a-f0-9]{64}$/);
  assert.equal(jestCacheKey(root), original);

  write("src/packages/server/node_modules/example/jest.config.js", "installed");
  write("src/packages/server/dist/tsconfig.json", "generated");
  write("src/packages/server/local/jest.config.js", "untracked");
  assert.equal(jestCacheKey(root), original);
  git("add", "src/packages/server/node_modules", "src/packages/server/dist");
  assert.equal(jestCacheKey(root), original);

  write(
    "src/packages/server/tsconfig.test.json",
    '{"extends":"../tsconfig.json"}',
  );
  const changed = jestCacheKey(root);
  assert.notEqual(changed, original);
  renameSync(
    join(root, "src/packages/server/tsconfig.test.json"),
    join(root, "src/packages/server/tsconfig.unit.json"),
  );
  git(
    "add",
    "-A",
    "src/packages/server/tsconfig.test.json",
    "src/packages/server/tsconfig.unit.json",
  );
  const renamed = jestCacheKey(root);
  assert.notEqual(renamed, changed);
  git("rm", "--force", "src/packages/server/tsconfig.unit.json");
  assert.notEqual(jestCacheKey(root), renamed);
});

test("fails closed when invoked outside the workspace", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ci-cache-key-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  assert.throws(() => jestCacheKey(root), /No tracked workspace lockfile/);
});
