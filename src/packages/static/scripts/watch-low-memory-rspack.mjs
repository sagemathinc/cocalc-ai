#!/usr/bin/env node

import { opendir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(__dirname, "..");
const packagesRoot = resolve(__dirname, "../..");

const pollMs = Math.max(
  250,
  Number.parseInt(process.env.COCALC_STATIC_WATCH_POLL_MS ?? "1500", 10) ||
    1500,
);
const debounceMs = Math.max(
  100,
  Number.parseInt(
    process.env.COCALC_STATIC_WATCH_DEBOUNCE_MS ?? "500",
    10,
  ) || 500,
);

const args = new Set(process.argv.slice(2));
const skipInitial = args.has("--skip-initial");
const help = args.has("--help") || args.has("-h");

const ignoreDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "dist",
  "dist-ts",
  "node_modules",
]);

if (help) {
  console.log(`Low-memory rspack watch mode.

This polls the packages tree for changes and runs one-shot "pnpm rspack build"
after a short debounce. It uses much less resident memory than "pnpm rspack build -w"
because rspack is only alive while actually building.

Usage:
  pnpm watch:low-mem

Environment:
  COCALC_STATIC_WATCH_POLL_MS       Poll interval in ms (default: ${pollMs})
  COCALC_STATIC_WATCH_DEBOUNCE_MS   Change debounce in ms (default: ${debounceMs})

Flags:
  --skip-initial   Do not run the initial build on startup
`);
  process.exit(0);
}

async function newestMtimeMs(root) {
  let newest = 0;

  async function walk(dir) {
    const handle = await opendir(dir);
    for await (const entry of handle) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(full);
      if (info.mtimeMs > newest) newest = info.mtimeMs;
    }
  }

  await walk(root);
  return newest;
}

function formatTs(ms) {
  return new Date(ms).toLocaleTimeString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runBuild(targetMtimeMs) {
  console.log(
    `[low-mem-watch] build start (${formatTs(Date.now())}) target=${Math.trunc(
      targetMtimeMs,
    )}`,
  );
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
    NO_RSPACK_DEV_SERVER: process.env.NO_RSPACK_DEV_SERVER || "yes",
  };
  const child = spawn("pnpm", ["rspack", "build"], {
    cwd: staticRoot,
    env,
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`rspack build failed with exit code ${exitCode}`);
  }
  console.log(
    `[low-mem-watch] build done  (${formatTs(Date.now())}) target=${Math.trunc(
      targetMtimeMs,
    )}`,
  );
}

let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

async function main() {
  let lastObservedMtimeMs = await newestMtimeMs(packagesRoot);
  let lastBuiltMtimeMs = 0;
  let queuedAtMs = skipInitial ? undefined : Date.now();

  if (skipInitial) {
    lastBuiltMtimeMs = lastObservedMtimeMs;
  } else {
    console.log("[low-mem-watch] initial build queued");
  }

  while (!stopping) {
    const observed = await newestMtimeMs(packagesRoot);
    if (observed > lastObservedMtimeMs) {
      lastObservedMtimeMs = observed;
      queuedAtMs = Date.now();
      console.log(
        `[low-mem-watch] change detected newest=${Math.trunc(observed)}`,
      );
    }

    if (
      queuedAtMs != null &&
      Date.now() - queuedAtMs >= debounceMs &&
      lastBuiltMtimeMs < lastObservedMtimeMs
    ) {
      const target = lastObservedMtimeMs;
      queuedAtMs = undefined;
      await runBuild(target);
      lastBuiltMtimeMs = target;
      continue;
    }

    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(`[low-mem-watch] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
