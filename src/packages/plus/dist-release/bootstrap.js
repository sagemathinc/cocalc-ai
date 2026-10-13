// CoCalc Plus bootstrap (pointer format v1).
//
// The launcher runs: node bootstrap.js <root>/apps/<R>/bundle/index.js
// [args...] with COCALC_PLUS_ACTIVE set to `v1 <R> <N> <B> <R>`. Before
// starting Lite, this checks that:
//   - this file is targets/<B>/bootstrap.js and hashes to B;
//   - manifests/<R>.json hashes to R and names exactly this Node (N, for this
//     platform) and this bootstrap (B);
//   - apps/<R> was completely assembled (its .complete marker names R).
// The release directory and the Node binary are verified when they are
// installed, not on every start. Then it pins this process (running/<pid>),
// so garbage collection keeps the release while it runs, and prepares the
// environment Lite expects.

"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { basename, dirname, join } = require("node:path");

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const bundle = process.argv[2];
const root = process.env.COCALC_PLUS_DIST_ROOT || "";

function fail(problem) {
  let origin = "https://software.cocalc.ai/software/plus";
  try {
    const recorded = fs.readFileSync(join(root, "origin"), "utf8").trim();
    if (/^https?:\/\/[A-Za-z0-9.:\/_-]+$/.test(recorded)) origin = recorded;
  } catch {}
  console.error(
    `cocalc-plus: ${problem}\n` +
      `To repair it, reinstall: curl -fsSL ${origin}/install.sh | sh`,
  );
  process.exit(1);
}

const line = process.env.COCALC_PLUS_ACTIVE ?? "";
const match =
  /^v1 ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(line);
if (!bundle || !root || match == null || match[1] !== match[4]) {
  fail(
    "CoCalc Plus must be started by its launcher (~/.local/bin/cocalc-plus).",
  );
}
const [, R, N, B] = match;
const app = join(root, "apps", R);
// (Node resolves symlinks in __filename, so only directory names are compared.)
if (
  basename(dirname(__filename)) !== B ||
  bundle !== join(app, "bundle", "index.js")
) {
  fail("the CoCalc Plus files do not match the active release.");
}
try {
  if (sha256(fs.readFileSync(__filename)) !== B) {
    fail("CoCalc Plus is damaged (its bootstrap does not match).");
  }
  const text = fs.readFileSync(join(root, "manifests", `${R}.json`));
  if (sha256(text) !== R) {
    fail("CoCalc Plus is damaged (its release manifest does not match).");
  }
  const manifest = JSON.parse(text.toString("utf8"));
  // What `cocalc-plus version` and Lite report.
  process.env.COCALC_PLUS_VERSION = `${manifest.version} (release ${manifest.release})`;
  const node =
    manifest.node?.platforms?.[`${process.platform}-${process.arch}`];
  if (manifest.bootstrap?.sha256 !== B || node?.sha256 !== N) {
    fail("the active release does not match its manifest.");
  }
  if (fs.readFileSync(join(app, ".complete"), "utf8") !== `${R}\n`) {
    fail("the active release was not completely installed.");
  }
} catch (err) {
  fail(`cannot read the installed CoCalc Plus: ${err}`);
}

// Pin this release while the process runs.
const pin = join(root, "running", `${process.pid}`);
try {
  fs.mkdirSync(join(root, "running"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pin, JSON.stringify({ line, role: "command" }) + "\n");
  process.on("exit", () => {
    try {
      if (JSON.parse(fs.readFileSync(pin, "utf8")).line === line) {
        fs.unlinkSync(pin);
      }
    } catch {}
  });
} catch {}

// What the old single-file executable set up before starting Lite.
const tools = join(app, "tools", "bin");
if (!process.env.COCALC_BIN_PATH && fs.existsSync(tools)) {
  process.env.COCALC_BIN_PATH = tools;
}
// The pinned Node goes on PATH too: tools/bin/cocalc (the CLI) runs `node`.
process.env.PATH = [
  process.env.COCALC_BIN_PATH,
  dirname(process.execPath),
  process.env.PATH,
]
  .filter(Boolean)
  .join(":");
process.env.AUTH_TOKEN ??= "random";
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const code = typeof warning === "object" ? warning?.code : undefined;
  if (code === "DEP0169") return;
  return emitWarning.call(process, warning, ...args);
};

process.chdir(dirname(bundle));
process.argv.splice(1, 2, bundle);
// Run the bundle as the main module: Lite's entry point checks
// require.main === module.
require("node:module").runMain();
