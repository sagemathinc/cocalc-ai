// Detects pnpm `tsc` shims in workspace packages that still run TypeScript < 7.
//
// TypeScript 7 is the only compiler (see
// src/.agents/typescript-7-migration-plan-2026-07-15.md), but pnpm does not
// remove `.bin` shims it no longer owns. A checkout installed before the switch
// keeps `node_modules/.bin/tsc` pointing at TypeScript 6 in packages that do not
// declare TypeScript themselves, so `pnpm exec tsc --build` there silently
// compiles with TypeScript 6. Fresh installs and CI are unaffected.
//
// Usage: node check-local-tsc.mjs [--fix]
//   --fix removes stale shims; `pnpm exec tsc` then resolves the workspace's
//   TypeScript 7 compiler.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = fileURLToPath(new URL("../packages/", import.meta.url));

export function isStaleTscShim(content) {
  const versions = [...content.matchAll(/typescript@(\d+)\./g)].map((match) =>
    Number(match[1]),
  );
  return versions.some((major) => major < 7);
}

export function tscShimPaths(packagesDir = PACKAGES) {
  const dirs = [packagesDir];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const dir = join(packagesDir, entry.name);
    dirs.push(dir);
    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (nested.isDirectory() && nested.name !== "node_modules") {
        dirs.push(join(dir, nested.name));
      }
    }
  }
  return dirs
    .map((dir) => join(dir, "node_modules", ".bin", "tsc"))
    .filter((path) => existsSync(path));
}

export function staleTscShims(packagesDir = PACKAGES) {
  return tscShimPaths(packagesDir).filter((path) =>
    isStaleTscShim(readFileSync(path, "utf8")),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fix = process.argv.includes("--fix");
  const stale = staleTscShims();
  for (const path of stale) {
    const name = relative(PACKAGES, path);
    if (fix) {
      rmSync(path, { force: true });
      console.log(`removed stale TypeScript < 7 tsc shim: ${name}`);
    } else {
      console.error(`stale TypeScript < 7 tsc shim: ${name}`);
    }
  }
  if (stale.length > 0 && !fix) {
    console.error(
      "Run `node src/scripts/check-local-tsc.mjs --fix` to remove them.",
    );
    process.exit(1);
  }
}
