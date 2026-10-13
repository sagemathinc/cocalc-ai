// CoCalc CLI bootstrap (pointer format v1).
//
// Run by the launcher as: node bootstrap.js <root>/targets/<sha256>/cocalc.js
// [args...]. It checks the bundle against the hash in its directory name and
// then runs it with the original arguments. That catches corruption and
// half-written files; it is not a defense against code running as the same
// user.

"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");

const bundle = process.argv[2];
if (!bundle) {
  console.error("cocalc: the bootstrap was started without a bundle.");
  process.exit(1);
}
const expected = basename(dirname(bundle));
let actual = "";
try {
  actual = createHash("sha256").update(readFileSync(bundle)).digest("hex");
} catch (err) {
  console.error(`cocalc: cannot read the installed CLI (${bundle}): ${err}`);
  process.exit(1);
}
if (actual !== expected) {
  let origin = "<site>";
  try {
    const recorded = readFileSync(
      join(dirname(dirname(dirname(bundle))), "origin"),
      "utf8",
    ).trim();
    if (/^https?:\/\/[A-Za-z0-9.:\/_-]+$/.test(recorded)) origin = recorded;
  } catch {}
  console.error(
    `cocalc: the installed CLI is damaged (${bundle} does not match its hash).\n` +
      `To repair it, reinstall: curl -fsSL ${origin}/cli/install.sh | sh`,
  );
  process.exit(1);
}
process.argv.splice(1, 2, bundle);
require(bundle);
