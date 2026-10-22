#!/usr/bin/env node

// CI build job only: turn off type checking in every workspace build, so the
// build just emits (JavaScript and .d.ts). The typecheck job checks the whole
// solution in parallel, off the path the test jobs wait on.
//
// It sets compilerOptions.noCheck in src/packages/tsconfig.json, which every
// workspace tsconfig extends. TypeScript records the skipped check in each
// tsbuildinfo, so a later plain `tsc --build` on the same tree still checks.
// Never run this in a checkout you develop in; it edits a tracked file.
//
//   node scripts/ci-tsc-emit-only.mjs [path/to/tsconfig.json]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_TSCONFIG = join(SRC_ROOT, "packages", "tsconfig.json");

export function setNoCheck(path = BASE_TSCONFIG) {
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // Comments or trailing commas: edit this script rather than guess.
    throw new Error(`${path} is not plain JSON: ${err.message}`);
  }
  config.compilerOptions = { ...config.compilerOptions, noCheck: true };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2] ? resolve(process.argv[2]) : BASE_TSCONFIG;
    setNoCheck(path);
    console.log(`Emit only: set compilerOptions.noCheck in ${path}`);
  } catch (err) {
    console.error(err?.stack ?? err);
    process.exit(1);
  }
}
