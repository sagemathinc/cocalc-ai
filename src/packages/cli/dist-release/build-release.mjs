#!/usr/bin/env node
/*
 * Build a CoCalc CLI release (distribution Phase A) into a directory:
 *
 *   <out>/files/<sha256>   the launcher, bootstrap, bundle and Node archives
 *   <out>/build.json       everything the release manifest needs except the
 *                          release number, which publish-release.mjs assigns
 *
 * Usage:
 *   node dist-release/build-release.mjs [--out DIR] [--bundle index.js]
 *     [--node-version 26.12.1] [--node-keyring pubring.kbx]
 *     [--skip-node-signature] [--platforms linux-x64,darwin-arm64]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addFile,
  gitIdentity,
  nodeSection,
  parseArgs,
  run,
  wantedPlatforms,
} from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(
    typeof args.out === "string"
      ? args.out
      : join(cliRoot, "build", "cli-release"),
  );
  const platforms = wantedPlatforms(args);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "files"), { recursive: true });

  let bundlePath =
    typeof args.bundle === "string" ? resolve(args.bundle) : undefined;
  if (!bundlePath) {
    run(process.execPath, [join(cliRoot, "sea", "build-bundle.mjs")]);
    bundlePath = join(cliRoot, "build", "bundle", "index.js");
  }
  const bundle = addFile(out, readFileSync(bundlePath));
  const launcher = addFile(out, readFileSync(join(here, "launcher.sh")));
  const bootstrap = addFile(out, readFileSync(join(here, "bootstrap.js")));
  const node = await nodeSection(out, args, platforms);

  const pkg = JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8"));
  const build = {
    version: pkg.version,
    git: gitIdentity(cliRoot),
    built_at: new Date().toISOString(),
    launcher,
    bootstrap,
    bundle,
    node,
  };
  writeFileSync(join(out, "build.json"), JSON.stringify(build, null, 2) + "\n");
  process.stdout.write(
    `CLI release built in ${out}: bundle ${bundle.sha256.slice(0, 12)}, Node ${node.version}\n`,
  );
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exit(1);
});
