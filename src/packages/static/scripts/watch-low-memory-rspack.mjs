#!/usr/bin/env node

import { createWriteStream } from "node:fs";
import {
  opendir,
  stat,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const staticRoot = resolve(__dirname, "..");
const packagesRoot = resolve(__dirname, "../..");
const srcRoot = resolve(packagesRoot, "..");
const stateDir = resolve(srcRoot, ".local", "static-watch-low-mem");
const lockPath = join(stateDir, "watch-low-mem.lock.json");
const statusPath = join(stateDir, "watch-low-mem.status.json");
const logPath = join(stateDir, "watch-low-mem.log");

const pollMs = Math.max(
  250,
  Number.parseInt(process.env.COCALC_STATIC_WATCH_POLL_MS ?? "1500", 10) ||
    1500,
);
const debounceMs = Math.max(
  100,
  Number.parseInt(process.env.COCALC_STATIC_WATCH_DEBOUNCE_MS ?? "500", 10) ||
    500,
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

This polls the packages tree for changes, runs a one-shot TypeScript solution
build, and only if that succeeds runs one-shot "pnpm rspack build".
It uses much less resident memory than long-lived watch modes because neither
TypeScript nor rspack stay resident between builds.

Usage:
  pnpm watch:low-mem

Environment:
  COCALC_STATIC_WATCH_POLL_MS       Poll interval in ms (default: ${pollMs})
  COCALC_STATIC_WATCH_DEBOUNCE_MS   Change debounce in ms (default: ${debounceMs})

State:
  Lock file:  ${lockPath}
  Status:     ${statusPath}
  Log file:   ${logPath}

Flags:
  --skip-initial   Do not run the initial build on startup
`);
  process.exit(0);
}

await mkdir(stateDir, { recursive: true });
const logStream = createWriteStream(logPath, { flags: "a" });

function nowIso() {
  return new Date().toISOString();
}

function writeLogLine(line) {
  logStream.write(`${line}\n`);
}

function log(message, { stderr = false } = {}) {
  const line = `[low-mem-watch] ${message}`;
  if (stderr) {
    console.error(line);
  } else {
    console.log(line);
  }
  writeLogLine(`${nowIso()} ${line}`);
}

function relayOutput(stream, { stderr = false, label }) {
  if (!stream) return;
  stream.on("data", (chunk) => {
    const text = chunk.toString();
    if (stderr) {
      process.stderr.write(text);
    } else {
      process.stdout.write(text);
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      writeLogLine(`${nowIso()} [${label}] ${line}`);
    }
  });
}

async function writeStatus(extra = {}) {
  await writeFile(
    statusPath,
    JSON.stringify(
      {
        pid: process.pid,
        started_at: startedAtIso,
        cwd: process.cwd(),
        static_root: staticRoot,
        packages_root: packagesRoot,
        lock_path: lockPath,
        log_path: logPath,
        ...extra,
      },
      null,
      2,
    ),
  );
}

const startedAtIso = nowIso();
let ownsLock = false;

async function readLockInfo() {
  try {
    const raw = await readFile(lockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function acquireLock() {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(
        JSON.stringify(
          {
            pid: process.pid,
            started_at: startedAtIso,
            cwd: process.cwd(),
            static_root: staticRoot,
            packages_root: packagesRoot,
            log_path: logPath,
            status_path: statusPath,
          },
          null,
          2,
        ),
      );
      ownsLock = true;
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err?.code !== "EEXIST") {
      throw err;
    }
    const info = await readLockInfo();
    const suffix = info?.pid
      ? ` already running (pid ${info.pid}, started ${info.started_at ?? "unknown"}).`
      : " already running.";
    throw new Error(
      `watch:low-mem${suffix} See ${logPath} and ${statusPath} for details.`,
    );
  }
}

async function releaseLock({ stopped = true } = {}) {
  if (!ownsLock) return;
  ownsLock = false;
  await writeStatus({ running: false, stopped_at: nowIso(), stopped });
  await rm(lockPath, { force: true });
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

async function runStep({ label, cwd, args, env }) {
  log(`${label} start (${formatTs(Date.now())}) cwd=${cwd}`);
  const child = spawn("pnpm", args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  relayOutput(child.stdout, { label, stderr: false });
  relayOutput(child.stderr, { label, stderr: true });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
  log(`${label} done  (${formatTs(Date.now())}) cwd=${cwd}`);
}

async function runBuild(targetMtimeMs) {
  log(
    `build start (${formatTs(Date.now())}) target=${Math.trunc(targetMtimeMs)}`,
  );
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "development",
    NO_RSPACK_DEV_SERVER: process.env.NO_RSPACK_DEV_SERVER || "yes",
  };
  await runStep({
    label: "tsc",
    cwd: packagesRoot,
    args: ["tsc", "--build", "--pretty", "tsconfig.solution.json"],
    env,
  });
  await runStep({
    label: "rspack",
    cwd: staticRoot,
    args: ["rspack", "build"],
    env,
  });
  log(
    `build done  (${formatTs(Date.now())}) target=${Math.trunc(targetMtimeMs)}`,
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
  try {
    await acquireLock();
    await writeStatus({ running: true });
    log(`acquired single-instance lock pid=${process.pid}`);
    log(`status=${statusPath}`);
    log(`log=${logPath}`);
    let lastObservedMtimeMs = await newestMtimeMs(packagesRoot);
    let lastHandledMtimeMs = 0;
    let queuedAtMs = skipInitial ? undefined : Date.now();

    if (skipInitial) {
      lastHandledMtimeMs = lastObservedMtimeMs;
    } else {
      log("initial build queued");
    }

    while (!stopping) {
      const observed = await newestMtimeMs(packagesRoot);
      if (observed > lastObservedMtimeMs) {
        lastObservedMtimeMs = observed;
        queuedAtMs = Date.now();
        log(`change detected newest=${Math.trunc(observed)}`);
      }

      if (
        queuedAtMs != null &&
        Date.now() - queuedAtMs >= debounceMs &&
        lastHandledMtimeMs < lastObservedMtimeMs
      ) {
        const target = lastObservedMtimeMs;
        queuedAtMs = undefined;
        try {
          await runBuild(target);
        } catch (err) {
          log(`${err instanceof Error ? err.message : err}`, { stderr: true });
        }
        lastHandledMtimeMs = target;
        continue;
      }

      await sleep(pollMs);
    }

    log("stopped");
  } finally {
    await releaseLock();
    logStream.end();
  }
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`, { stderr: true });
  logStream.end();
  process.exit(1);
});
