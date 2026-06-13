#!/usr/bin/env node

/*
 * This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

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

function resolveBundleDir(initialDir, fallbackDir) {
  const candidates = [];
  if (initialDir) {
    candidates.push(initialDir);
    candidates.push(join(initialDir, ".."));
  }
  if (fallbackDir) {
    candidates.push(fallbackDir);
  }
  candidates.push(process.cwd());

  for (const candidate of candidates) {
    if (hasBundleMarkers(candidate)) {
      return candidate;
    }
  }

  return initialDir ?? fallbackDir ?? process.cwd();
}

function prependPath(dir) {
  if (!dir || !existsSync(dir)) {
    return;
  }
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
}

(async () => {
  try {
    process.env.COCALC_PRODUCT ??= "launchpad";
    process.env.COCALC_DISABLE_NEXT ??= "1";
    process.env.NO_RSPACK_DEV_SERVER ??= "1";
    process.env.COCALC_BAY_CLOUDFLARED_SYSTEMD ??= "1";

    const bundledRootCandidate = join(__dirname, "..", "..", "..");
    const bundleDir = resolveBundleDir(
      process.env.COCALC_BUNDLE_DIR,
      bundledRootCandidate,
    );
    process.env.COCALC_BUNDLE_DIR = bundleDir;

    prependPath(join(bundleDir, "node_modules", ".bin"));
    prependPath(join(bundleDir, "bundle", "node_modules", ".bin"));
    prependPath(join(process.cwd(), "node_modules", ".bin"));
    prependPath(dirname(process.execPath));

    const {
      runLaunchpadCloudflaredForeground,
    } = require("@cocalc/server/launchpad/cloudflared-systemd");
    await runLaunchpadCloudflaredForeground();
  } catch (err) {
    console.error("cocalc-rocket cloudflared failed:", err);
    process.exitCode = 1;
  }
})();
