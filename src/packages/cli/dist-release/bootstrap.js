// CoCalc CLI bootstrap (pointer format v1).
//
// The launcher runs: node bootstrap.js <root>/targets/<C>/cocalc.js [args...]
// with COCALC_CLI_ACTIVE set to the `active` line `v1 <R> <N> <B> <C>`. Before
// running the bundle, this checks that:
//   - this file is targets/<B>/bootstrap.js and hashes to B;
//   - manifests/<R>.json hashes to R and names exactly this Node (N, for this
//     platform), this bootstrap (B) and this bundle (C);
//   - the bundle hashes to C.
// That catches corruption, half-written files and mixed-up releases. It is
// not a defense against code running as the same user. (The Node binary is
// checked when it is installed or reused, not on every run.)

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const bundle = process.argv[2];
const root = bundle ? dirname(dirname(dirname(bundle))) : "";

function fail(problem) {
  let origin = "<site>";
  try {
    const recorded = readFileSync(join(root, "origin"), "utf8").trim();
    if (/^https?:\/\/[A-Za-z0-9.:\/_-]+$/.test(recorded)) origin = recorded;
  } catch {}
  console.error(
    `cocalc: ${problem}\n` +
      `To repair it, reinstall: curl -fsSL ${origin}/cli/install.sh | sh`,
  );
  process.exit(1);
}

const match =
  /^v1 ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(
    process.env.COCALC_CLI_ACTIVE ?? "",
  );
if (!bundle || match == null) {
  fail("the CLI must be started by its launcher (~/.local/bin/cocalc).");
}
const [, R, N, B, C] = match;
// (Node resolves symlinks in __filename, e.g. /tmp -> /private/tmp on macOS,
// so only the directory names are compared.)
if (basename(dirname(bundle)) !== C || basename(dirname(__filename)) !== B) {
  fail("the CLI's files do not match its active release.");
}
try {
  if (sha256(readFileSync(__filename)) !== B) {
    fail("the installed CLI is damaged (its bootstrap does not match).");
  }
  const text = readFileSync(join(root, "manifests", `${R}.json`));
  if (sha256(text) !== R) {
    fail("the installed CLI is damaged (its release manifest does not match).");
  }
  const manifest = JSON.parse(text.toString("utf8"));
  const node =
    manifest.node?.platforms?.[`${process.platform}-${process.arch}`];
  if (
    manifest.bootstrap?.sha256 !== B ||
    manifest.bundle?.sha256 !== C ||
    node?.sha256 !== N
  ) {
    fail("the CLI's active release does not match its manifest.");
  }
  if (sha256(readFileSync(bundle)) !== C) {
    fail(`the installed CLI is damaged (${bundle} does not match its hash).`);
  }
} catch (err) {
  fail(`cannot read the installed CLI: ${err}`);
}
process.argv.splice(1, 2, bundle);
require(bundle);
