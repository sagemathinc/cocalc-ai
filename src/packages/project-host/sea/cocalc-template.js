/*
This is run when starting the SEA executable.
This template is shared by other bundles; keep it generic and rely on
render-template.js to provide NAME, VERSION, and MAIN.
*/

const path = require("node:path");
const fs = require("node:fs");
const repl = require("node:repl");
const os = require("node:os");
const crypto = require("node:crypto");

// render-template.js fills NAME/VERSION/MAIN.
const version = "${VERSION}";
const embeddedBundleHash = "${ASSET_HASH}";
const exeName = path.basename(process.argv[0] ?? "");
const inferredName = exeName.startsWith("cocalc-plus") ? "cocalc-plus" : "";
const unsubstitutedName = "$" + "{NAME}";
const configuredName = "${NAME}";
const name =
  configuredName === unsubstitutedName || configuredName === ""
    ? process.env.COCALC_NAME || inferredName || "cocalc"
    : configuredName;
const displayName =
  name === "cocalc-plus"
    ? "CoCalc Plus"
    : name === "cocalc-project-host"
      ? "CoCalc Project Host"
      : name;
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

function configureProcessMaxListeners() {
  const configured = Number.parseInt(
    `${process.env.COCALC_PROCESS_MAX_LISTENERS ?? ""}`,
    10,
  );
  const limit =
    Number.isInteger(configured) && configured > 0 ? configured : 50;
  if (process.getMaxListeners() < limit) {
    process.setMaxListeners(limit);
  }
}

configureProcessMaxListeners();

function extractAssetsSync() {
  const { getRawAsset } = require("node:sea");
  const os = require("node:os");
  const { spawnSync } = require("node:child_process");
  let assetBuffer;
  const getAssetBuffer = () => {
    if (!assetBuffer) {
      const ab = getRawAsset("cocalc.tar.xz");
      assetBuffer = Buffer.from(new Uint8Array(ab));
    }
    return assetBuffer;
  };

  const cacheRoot = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "cocalc",
  );
  const destDir = path.join(cacheRoot, name);
  const metadataPath = path.join(destDir, ".cocalc-sea-cache.json");
  const lockDir = path.join(cacheRoot, `.${name}.extract.lock`);

  const bundleHash =
    embeddedBundleHash && !embeddedBundleHash.includes("{ASSET_HASH}")
      ? embeddedBundleHash
      : crypto.createHash("sha256").update(getAssetBuffer()).digest("hex");
  const expectedMetadata = {
    name,
    version,
    mainScript,
    bundleHash,
  };

  const isReady = () => {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      return (
        metadata.name === expectedMetadata.name &&
        metadata.version === expectedMetadata.version &&
        metadata.mainScript === expectedMetadata.mainScript &&
        metadata.bundleHash === expectedMetadata.bundleHash &&
        fs.existsSync(path.join(destDir, mainScript))
      );
    } catch {
      return false;
    }
  };

  const acquireLock = () => {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(
          path.join(lockDir, "owner.json"),
          JSON.stringify(
            {
              pid: process.pid,
              createdAt: new Date().toISOString(),
              bundleHash,
            },
            null,
            2,
          ),
        );
        return;
      } catch (err) {
        if (err?.code !== "EEXIST") {
          throw err;
        }
        try {
          const stat = fs.statSync(lockDir);
          if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Retry; another process may have just released the lock.
        }
        if (isReady()) {
          return "ready";
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
    throw new Error(
      `timed out waiting for SEA asset extraction lock ${lockDir}`,
    );
  };

  const releaseLock = () => {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  if (!isReady()) {
    const lockResult = acquireLock();
    if (lockResult !== "ready" && !isReady()) {
      log("Unpacking...");
      const tmpDir = path.join(
        cacheRoot,
        `.${name}.extract.${process.pid}.${Date.now()}`,
      );
      const oldDir = path.join(
        cacheRoot,
        `.${name}.old.${process.pid}.${Date.now()}`,
      );

      try {
        const buf = getAssetBuffer();
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        const child = spawnSync(
          "tar",
          ["-Jxf", "-", "-C", tmpDir, "--strip-components=1"],
          { input: buf, stdio: ["pipe", "inherit", "inherit"] },
        );

        if (child.error) {
          throw new Error(`Failed to run tar: ${child.error.message}`);
        }
        if (child.status !== 0) {
          throw new Error(`tar exited with code ${child.status}`);
        }

        fs.writeFileSync(
          path.join(tmpDir, ".cocalc-sea-cache.json"),
          JSON.stringify(
            {
              ...expectedMetadata,
              extractedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );

        if (fs.existsSync(destDir)) {
          fs.rmSync(oldDir, { recursive: true, force: true });
          fs.renameSync(destDir, oldDir);
        }
        fs.renameSync(tmpDir, destDir);
        fs.rmSync(oldDir, { recursive: true, force: true });
      } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        if (fs.existsSync(oldDir) && !fs.existsSync(destDir)) {
          try {
            fs.renameSync(oldDir, destDir);
          } catch {
            // If rollback fails, report the original extraction failure below.
          }
        }
        console.error(err?.message || err);
        process.exit(1);
      } finally {
        releaseLock();
      }
    } else if (lockResult !== "ready") {
      releaseLock();
    }
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
  log(displayName + " (v" + version + ")");

  const script = path.join(destDir, mainScript);

  if (!fs.existsSync(script)) {
    console.error(`missing ${mainScript} at`, script);
    process.exit(1);
  }

  process.chdir(path.dirname(script));
  const argv = process.argv.slice(2);
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
        typeof warning === "string" ? warning : (warning?.message ?? "");
      const code = typeof warning === "object" ? warning?.code : undefined;
      if (code === "DEP0169") {
        return;
      }
      return originalEmitWarning.call(process, warning, ...args);
    };
  }
}

Module.runMain();
