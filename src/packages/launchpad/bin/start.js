#!/usr/bin/env node
// CoCalc Launchpad CLI entrypoint. Boots the Hub control plane in
// pglite + nextless mode with lightweight defaults.
const { dirname, join } = require("path");
const { existsSync } = require("fs");
const {
  applyLaunchpadDefaults,
  logLaunchpadConfig,
} = require("../lib/onprem-config");

function hasBundleMarkers(dir) {
  return (
    !!dir &&
    (existsSync(join(dir, "bundle")) ||
      existsSync(join(dir, "http-api-dist")) ||
      existsSync(join(dir, "public")))
  );
}

function addCandidate(candidates, dir) {
  if (!dir || candidates.includes(dir)) {
    return;
  }
  candidates.push(dir);
}

function resolveBundleDir(initialDir, fallbackDirs) {
  const candidates = [];
  if (initialDir) {
    addCandidate(candidates, initialDir);
    addCandidate(candidates, join(initialDir, ".."));
  }
  for (const fallbackDir of fallbackDirs ?? []) {
    addCandidate(candidates, fallbackDir);
  }
  addCandidate(candidates, process.cwd());

  for (const candidate of candidates) {
    if (hasBundleMarkers(candidate)) {
      return candidate;
    }
  }

  return initialDir ?? fallbackDirs?.[0] ?? process.cwd();
}

function prependPath(dir) {
  if (!dir || !existsSync(dir)) {
    return;
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

(async () => {
  try {
    await applyLaunchpadDefaults();
    // Avoid inheriting stale postgres socket/user from a different checkout.
    if (process.env.COCALC_DB === "pglite") {
      delete process.env.PGHOST;
      delete process.env.PGUSER;
      delete process.env.PGDATABASE;
    }
    logLaunchpadConfig();
    if (process.env.COCALC_OPEN_BROWSER == null) {
      process.env.COCALC_OPEN_BROWSER = "1";
    }
    process.env.COCALC_LAUNCHPAD_API_V2_ROUTES = "1";

    const bundleDir = resolveBundleDir(process.env.COCALC_BUNDLE_DIR, [
      // ncc output: build/bundle/bundle/index.js with assets in build/bundle.
      join(__dirname, ".."),
      // Source checkout: packages/launchpad/bin/start.js.
      join(__dirname, "..", "..", ".."),
    ]);
    process.env.COCALC_BUNDLE_DIR = bundleDir;
    const pgliteBundleCandidates = [
      join(bundleDir, "pglite"),
      join(
        bundleDir,
        "bundle",
        "node_modules",
        "@electric-sql",
        "pglite",
        "dist",
      ),
    ];
    if (!process.env.COCALC_PGLITE_BUNDLE_DIR) {
      for (const pgliteBundleDir of pgliteBundleCandidates) {
        if (existsSync(join(pgliteBundleDir, "pglite.data"))) {
          process.env.COCALC_PGLITE_BUNDLE_DIR = pgliteBundleDir;
          break;
        }
      }
    }
    const apiRootCandidates = [
      join(bundleDir, "http-api-dist", "pages", "api", "v2"),
      join(
        bundleDir,
        "bundle",
        "node_modules",
        "@cocalc",
        "http-api",
        "dist",
        "pages",
        "api",
        "v2",
      ),
    ];
    if (!process.env.COCALC_API_V2_ROOT) {
      for (const apiRoot of apiRootCandidates) {
        if (existsSync(apiRoot)) {
          process.env.COCALC_API_V2_ROOT = apiRoot;
          break;
        }
      }
    }

    // put path to special node binaries if available
    prependPath(join(bundleDir, "node_modules", ".bin"));
    prependPath(join(bundleDir, "bundle", "node_modules", ".bin"));
    prependPath(join(process.cwd(), "node_modules", ".bin"));
    prependPath(dirname(process.execPath));

    if (!process.argv.includes("--all")) {
      process.argv.push("--all");
    }
    require("@cocalc/hub/hub");
  } catch (err) {
    console.error("cocalc-launchpad failed to start:", err);
    process.exitCode = 1;
  }
})();
