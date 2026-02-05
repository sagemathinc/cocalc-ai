/*
This is run when starting the SEA executable.
This template is shared by other bundles; keep it generic and rely on
envsubst to provide NAME, VERSION, and MAIN.
*/

const path = require("node:path");
const fs = require("node:fs");
const repl = require("node:repl");
const os = require("node:os");

// DO NOT use ${} in this file; envsubst fills NAME/VERSION/MAIN.
const version = "${VERSION}";
const exeName = path.basename(process.argv[0] ?? "");
const inferredName = exeName.startsWith("cocalc-plus") ? "cocalc-plus" : "";
const name =
  "${NAME}" || process.env.COCALC_NAME || inferredName || "cocalc";
const mainScript = "${MAIN}";
const quiet =
  process.env.COCALC_SEA_QUIET === "1" ||
  process.argv.includes("reflect") ||
  process.argv.includes("reflect-sync") ||
  process.argv.includes("--run-reflect");

function log(...args) {
  if (!quiet) {
    console.log(...args);
  }
}

function extractAssetsSync() {
  const { getRawAsset } = require("node:sea");
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");

  const destDir = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "cocalc",
    name,
    version,
  );

  const stamp = path.join(destDir, ".ok");
  if (!fs.existsSync(stamp)) {
    log("Unpacking...");
    const ab = getRawAsset("cocalc.tar.xz");
    const buf = Buffer.from(new Uint8Array(ab));

    fs.mkdirSync(destDir, { recursive: true });

    const child = spawnSync(
      "tar",
      ["-Jxf", "-", "-C", destDir, "--strip-components=1"],
      { input: buf, stdio: ["pipe", "inherit", "inherit"] },
    );

    if (child.error) {
      console.error("Failed to run tar:", child.error);
      process.exit(1);
    }
    if (child.status !== 0) {
      console.error("tar exited with code", child.status);
      process.exit(child.status);
    }

    fs.writeFileSync(stamp, "");
  }
  log("Assets ready at:", destDir);
  return destDir;
}

const Module = require("node:module");

if (path.basename(process.argv[1]) == "node") {
  const noUserScript =
    process.argv.length === 2 ||
    (process.argv.length === 3 &&
      (process.argv[2] === "-i" || process.argv[2] === "--interactive"));

  if (noUserScript) {
    const historyFile = path.join(os.homedir(), ".node_repl_history");
    const r = repl.start({
      prompt: "> ",
      useGlobal: true,
      ignoreUndefined: false,
    });
    r.setupHistory(historyFile, (err) => {
      if (err) console.error("REPL history error:", err);
    });
    return;
  }

  process.argv = [process.execPath, ...process.argv.slice(2)];
} else if (process.argv[2] == "-v" || process.argv[2] == "--version") {
  console.log(version);
  process.exit(0);
} else {
  const destDir = extractAssetsSync();
  log("CoCalc Project Host (v" + version + ")");

  const script = path.join(destDir, mainScript);

  if (!fs.existsSync(script)) {
    console.error(`missing ${mainScript} at`, script);
    process.exit(1);
  }

  process.chdir(path.dirname(script));
  const argv = process.argv.slice(1);
  if (argv[0] === process.argv[0]) {
    argv.shift();
  }
  process.argv = [process.execPath, script, ...argv];
  const binPath =
    process.env.COCALC_BIN_PATH ||
    path.join(destDir, `src/packages/${name}/bin/`);
  if (!process.env.COCALC_BIN_PATH) {
    process.env.COCALC_BIN_PATH = binPath;
  }
  process.env.PATH = binPath + path.delimiter + process.env.PATH;
  process.env.COCALC_PROJECT_HOST_VERSION ??= version;
  process.env.COCALC_SEA_VERSION ??= version;

  process.env.AUTH_TOKEN ??= "random";

  if (name === "cocalc-plus" || inferredName === "cocalc-plus") {
    const originalEmitWarning = process.emitWarning;
    process.emitWarning = (warning, ...args) => {
      const message =
        typeof warning === "string" ? warning : warning?.message ?? "";
      const code = typeof warning === "object" ? warning?.code : undefined;
      if (
        message.includes("SQLite is an experimental feature") ||
        code === "DEP0169"
      ) {
        return;
      }
      return originalEmitWarning.call(process, warning, ...args);
    };
  }
}

Module.runMain();
