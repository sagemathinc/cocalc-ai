#!/usr/bin/env node
// Installed as cocalc-cli.js next to the CLI bundle (cocalc-cli-bundle.js):
// it starts the bundle with V8's compile cache on, so later runs reuse the
// compiled code instead of compiling about 6 MB of JavaScript again (about
// a fifth of the CLI's startup). The cache is keyed by file content, so an
// upgraded bundle just misses it once. NODE_COMPILE_CACHE, if set, wins.
"use strict";
const { lstatSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

// This user's cache directory under root, or undefined. The temporary
// directory may be shared, so only a directory that is really this user's
// is used: nobody else may plant compiled code in it.
function compileCacheDir(root, uid = process.getuid?.()) {
  const dir = join(
    root,
    `cocalc-cli-compile-cache${uid == null ? "" : `-${uid}`}`,
  );
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {}
  try {
    const stat = lstatSync(dir);
    if (
      stat.isDirectory() &&
      (uid == null || (stat.uid === uid && (stat.mode & 0o022) === 0))
    )
      return dir;
  } catch {}
  return undefined;
}

if (require.main === module) {
  try {
    const { enableCompileCache } = require("node:module");
    if (!process.env.NODE_COMPILE_CACHE && enableCompileCache) {
      const dir = compileCacheDir(require("node:os").tmpdir());
      if (dir) enableCompileCache(dir);
    }
  } catch {}
  require("./cocalc-cli-bundle.js");
} else {
  module.exports = { compileCacheDir };
}
