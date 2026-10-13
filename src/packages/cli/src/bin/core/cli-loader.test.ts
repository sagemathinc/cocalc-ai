import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// sea/cli-loader.cjs, installed as cocalc-cli.js next to the bundle.
function loaderPath(): string {
  for (let dir = __dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "cli", "sea", "cli-loader.cjs");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("sea/cli-loader.cjs not found");
}

const posix = process.platform !== "win32";

test("the loader runs the bundle next to it, with the compile cache on", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-loader-"));
  try {
    copyFileSync(loaderPath(), join(dir, "cocalc-cli.js"));
    writeFileSync(
      join(dir, "cocalc-cli-bundle.js"),
      `console.log(JSON.stringify({ cache: require("node:module").getCompileCacheDir?.() ?? null, argv: process.argv.slice(2) }));`,
    );
    const env = { ...process.env };
    delete env.NODE_COMPILE_CACHE;
    const run = spawnSync(
      process.execPath,
      [join(dir, "cocalc-cli.js"), "project", "--json"],
      { env, encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    const { cache, argv } = JSON.parse(run.stdout);
    assert.deepEqual(argv, ["project", "--json"]);
    assert.ok(
      cache.startsWith(
        join(
          tmpdir(),
          `cocalc-cli-compile-cache${posix ? `-${process.getuid!()}` : ""}`,
        ),
      ),
      cache,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "the cache directory is the user's own, never one others can write",
  { skip: !posix },
  () => {
    const { compileCacheDir } = require(loaderPath());
    const root = mkdtempSync(join(tmpdir(), "cli-loader-"));
    try {
      const uid = process.getuid!();
      const dir = compileCacheDir(root, uid);
      assert.equal(dir, join(root, `cocalc-cli-compile-cache-${uid}`));
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      // Someone made it writable by others (or it belongs to someone else).
      chmodSync(dir, 0o777);
      assert.equal(compileCacheDir(root, uid), undefined);
      assert.equal(compileCacheDir(root, uid + 1), undefined);
      // Not a directory at all.
      mkdirSync(join(root, "x"));
      writeFileSync(join(root, "x", `cocalc-cli-compile-cache-${uid}`), "");
      assert.equal(compileCacheDir(join(root, "x"), uid), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
