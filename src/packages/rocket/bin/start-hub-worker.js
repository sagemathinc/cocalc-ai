#!/usr/bin/env node

// Rocket/systemd hub worker entrypoint. This uses the compact launchpad-style
// bundle layout without applying launchpad's single-node defaults.

const { dirname, join } = require("path");
const { existsSync } = require("fs");

function hasBundleMarkers(dir) {
  return (
    !!dir &&
    (existsSync(join(dir, "bundle")) ||
      existsSync(join(dir, "http-api-dist")) ||
      existsSync(join(dir, "public")))
  );
}

function resolveBundleDir(initialDir, fallbackDirs) {
  const candidates = [];
  if (initialDir) {
    candidates.push(initialDir);
    candidates.push(join(initialDir, ".."));
  }
  for (const fallbackDir of Array.isArray(fallbackDirs)
    ? fallbackDirs
    : [fallbackDirs]) {
    if (fallbackDir) {
      candidates.push(fallbackDir);
    }
  }
  candidates.push(process.cwd());

  for (const candidate of candidates) {
    if (hasBundleMarkers(candidate)) {
      return candidate;
    }
  }

  return initialDir ?? candidates.find(Boolean) ?? process.cwd();
}

function prependPath(dir) {
  if (!dir || !existsSync(dir)) {
    return;
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

function setIfExists(envName, candidates) {
  if (process.env[envName]) {
    return;
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      process.env[envName] = candidate;
      return;
    }
  }
}

(async () => {
  try {
    process.env.COCALC_PRODUCT ??= "launchpad";
    process.env.COCALC_DISABLE_NEXT ??= "1";
    process.env.NO_RSPACK_DEV_SERVER ??= "1";

    const bundledRootCandidates = [
      join(__dirname, ".."),
      join(__dirname, "..", "..", ".."),
    ];
    const bundleDir = resolveBundleDir(
      process.env.COCALC_BUNDLE_DIR,
      bundledRootCandidates,
    );
    process.env.COCALC_BUNDLE_DIR = bundleDir;

    setIfExists("COCALC_API_V2_ROUTES_BUNDLE", [
      join(bundleDir, "api-v2-routes", "index.js"),
    ]);

    setIfExists("COCALC_API_V2_ROOT", [
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
    ]);

    setIfExists("COCALC_PGLITE_BUNDLE_DIR", [
      join(bundleDir, "pglite"),
      join(
        bundleDir,
        "bundle",
        "node_modules",
        "@electric-sql",
        "pglite",
        "dist",
      ),
    ]);

    prependPath(join(bundleDir, "node_modules", ".bin"));
    prependPath(join(bundleDir, "bundle", "node_modules", ".bin"));
    prependPath(join(process.cwd(), "node_modules", ".bin"));
    prependPath(dirname(process.execPath));

    require("@cocalc/hub/hub");
  } catch (err) {
    console.error("cocalc-rocket hub worker failed to start:", err);
    process.exitCode = 1;
  }
})();
