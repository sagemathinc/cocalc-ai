#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const PACKAGES_DIR = join(ROOT, "packages");
const DEFAULT_FILE_THRESHOLD_MS = 60_000;
const DEFAULT_TEST_THRESHOLD_MS = 10_000;
const DEFAULT_TOP_FILES = 40;
const DEFAULT_TOP_TESTS = 30;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CONCURRENCY = 1;
const TEST_ENV_SCRUB_KEYS = [
  "COCALC_API_URL",
  "COCALC_BEARER_TOKEN",
  "COCALC_AGENT_TOKEN",
  "COCALC_PROJECT_ID",
  "COCALC_SECRET_TOKEN",
  "COCALC_CONTROL_DIR",
  "COCALC_TERMINAL_FILENAME",
  "COCALC_BROWSER_ID",
];

const PACKAGE_OVERRIDES = {
  backend: {
    env: { NODE_NO_WARNINGS: "1" },
    args: ["exec", "jest"],
  },
  database: {
    env: {
      NODE_NO_WARNINGS: "1",
      COCALC_TEST_USE_PGLITE: "1",
      NODE_OPTIONS: "--experimental-vm-modules",
    },
    args: ["exec", "jest", "--forceExit"],
  },
  frontend: {
    // The normal package test also runs frontend lint.  This audit is about
    // Jest test timing, so run Jest directly.
    args: ["exec", "jest"],
  },
  server: {
    env: {
      NODE_NO_WARNINGS: "1",
      COCALC_TEST_USE_PGLITE: "1",
      NODE_OPTIONS: "--experimental-vm-modules",
      TZ: "UTC",
    },
    args: ["exec", "jest", "--maxWorkers=8"],
  },
};

function usage() {
  console.log(`Usage: pnpm test:audit [options]

Runs Jest-backed package tests with JSON output, then reports slow test files,
slow individual tests, and timeout/failure candidates.

Options:
  --packages=a,b       Comma-separated package names, e.g. server,frontend
  --exclude=a,b        Comma-separated package names to skip
  --concurrency=n      Number of package test commands to run at once
                       default: ${DEFAULT_CONCURRENCY}
  --timeout-ms=n       Per-package timeout in milliseconds
                       default: ${DEFAULT_TIMEOUT_MS}
  --file-threshold-ms=n  Warn for test files slower than this
                         default: ${DEFAULT_FILE_THRESHOLD_MS}
  --test-threshold-ms=n  Warn for individual tests slower than this
                         default: ${DEFAULT_TEST_THRESHOLD_MS}
  --top-files=n        Number of slow files to print
                       default: ${DEFAULT_TOP_FILES}
  --top-tests=n        Number of slow individual tests to print
                       default: ${DEFAULT_TOP_TESTS}
  --out=path           Output directory for Jest JSON files
                       default: /tmp/cocalc-test-audit-<timestamp>
  --keep-output        Keep previous output directory contents
  --list-packages      Print detected Jest-backed packages and exit
  --help              Show this help

Examples:
  pnpm test:audit --packages=server,frontend
  pnpm test:audit --concurrency=2 --file-threshold-ms=45000
`);
}

function parseArgs(argv) {
  const opts = {
    packages: undefined,
    exclude: new Set(),
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    fileThresholdMs: DEFAULT_FILE_THRESHOLD_MS,
    testThresholdMs: DEFAULT_TEST_THRESHOLD_MS,
    topFiles: DEFAULT_TOP_FILES,
    topTests: DEFAULT_TOP_TESTS,
    out: join(tmpdir(), `cocalc-test-audit-${Date.now()}`),
    keepOutput: false,
    listPackages: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--keep-output") {
      opts.keepOutput = true;
      continue;
    }
    if (arg === "--list-packages") {
      opts.listPackages = true;
      continue;
    }
    const [key, value] = arg.split("=", 2);
    if (value == null) {
      throw new Error(`unknown argument ${arg}`);
    }
    switch (key) {
      case "--packages":
        opts.packages = value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        break;
      case "--exclude":
        opts.exclude = new Set(
          value
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
        );
        break;
      case "--concurrency":
        opts.concurrency = positiveInt(value, key);
        break;
      case "--timeout-ms":
        opts.timeoutMs = positiveInt(value, key);
        break;
      case "--file-threshold-ms":
        opts.fileThresholdMs = positiveInt(value, key);
        break;
      case "--test-threshold-ms":
        opts.testThresholdMs = positiveInt(value, key);
        break;
      case "--top-files":
        opts.topFiles = positiveInt(value, key);
        break;
      case "--top-tests":
        opts.topTests = positiveInt(value, key);
        break;
      case "--out":
        opts.out = resolve(value);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return opts;
}

function positiveInt(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return n;
}

function packageJson(name) {
  return JSON.parse(
    readFileSync(join(PACKAGES_DIR, name, "package.json"), "utf8"),
  );
}

function discoverPackages() {
  const packages = [];
  for (const name of readdirSync(PACKAGES_DIR).sort()) {
    const packageJsonPath = join(PACKAGES_DIR, name, "package.json");
    if (!existsSync(packageJsonPath)) continue;
    const pkg = packageJson(name);
    const testScript = pkg.scripts?.test ?? "";
    if (!/\bjest\b/.test(testScript) && !PACKAGE_OVERRIDES[name]) continue;
    packages.push({
      name,
      testScript,
      path: join(PACKAGES_DIR, name),
    });
  }
  return packages;
}

function commandForPackage(pkg, outputFile) {
  const override = PACKAGE_OVERRIDES[pkg.name] ?? {};
  const baseArgs = override.args ?? ["run", "test"];
  return {
    cmd: "pnpm",
    args: [...baseArgs, "--json", "--outputFile", outputFile, "--silent"],
    env: {
      ...process.env,
      ...override.env,
      DEBUG: "",
    },
  };
}

function scrubLiveEnv(env) {
  const scrubbed = { ...env };
  for (const key of TEST_ENV_SCRUB_KEYS) {
    delete scrubbed[key];
  }
  return scrubbed;
}

function formatMs(ms) {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function tailAppend(tail, chunk, limit = 12_000) {
  const next = tail + chunk;
  return next.length <= limit ? next : next.slice(next.length - limit);
}

function runPackage(pkg, outputFile, opts) {
  return new Promise((resolveRun) => {
    const { cmd, args, env } = commandForPackage(pkg, outputFile);
    const start = Date.now();
    let stdoutTail = "";
    let stderrTail = "";
    let timedOut = false;
    console.log(`\n[${pkg.name}] ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: pkg.path,
      env: scrubLiveEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
    }, opts.timeoutMs);
    child.stdout.on("data", (data) => {
      stdoutTail = tailAppend(stdoutTail, data.toString());
    });
    child.stderr.on("data", (data) => {
      stderrTail = tailAppend(stderrTail, data.toString());
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const elapsedMs = Date.now() - start;
      const result = {
        package: pkg.name,
        outputFile,
        code,
        signal,
        timedOut,
        elapsedMs,
        stdoutTail,
        stderrTail,
      };
      const status = timedOut
        ? "TIMEOUT"
        : code === 0
          ? "ok"
          : `exit ${code ?? signal}`;
      console.log(`[${pkg.name}] ${status} in ${formatMs(elapsedMs)}`);
      if (code !== 0 || timedOut) {
        const tail = `${stdoutTail}\n${stderrTail}`.trim();
        if (tail) {
          console.log(`[${pkg.name}] output tail:\n${tail}`);
        }
      }
      resolveRun(result);
    });
  });
}

async function runWithConcurrency(items, concurrency, fn) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

function readJsonResults(outputFile) {
  if (!existsSync(outputFile)) return undefined;
  try {
    return JSON.parse(readFileSync(outputFile, "utf8"));
  } catch (err) {
    return { parseError: `${err}` };
  }
}

function aggregate(results, opts) {
  const packages = [];
  const files = [];
  const tests = [];
  const failures = [];
  for (const result of results) {
    const data = readJsonResults(result.outputFile);
    if (!data || data.parseError) {
      packages.push({
        name: result.package,
        wallMs: result.elapsedMs,
        suiteCount: 0,
        testCount: 0,
        sumMs: 0,
        nonPassedSuites: result.code === 0 ? 0 : 1,
        commandFailed: result.code !== 0 || result.timedOut,
      });
      failures.push({
        package: result.package,
        file: "(no JSON results)",
        status: result.timedOut ? "timed-out" : "command-failed",
        ms: result.elapsedMs,
      });
      continue;
    }
    const packageFiles = data.testResults ?? [];
    let sumMs = 0;
    let minStart = Infinity;
    let maxEnd = 0;
    let nonPassedSuites = 0;
    for (const suite of packageFiles) {
      const ms = Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0));
      sumMs += ms;
      minStart = Math.min(minStart, suite.startTime ?? Infinity);
      maxEnd = Math.max(maxEnd, suite.endTime ?? 0);
      const rel = relative(PACKAGES_DIR, suite.name ?? "");
      const fileRow = {
        package: result.package,
        file: rel || suite.name,
        status: suite.status,
        ms,
        testCount: suite.assertionResults?.length ?? 0,
      };
      files.push(fileRow);
      if (suite.status !== "passed") {
        nonPassedSuites += 1;
        failures.push(fileRow);
      }
      for (const assertion of suite.assertionResults ?? []) {
        tests.push({
          package: result.package,
          file: rel || suite.name,
          status: assertion.status,
          ms: assertion.duration ?? 0,
          name: assertion.fullName ?? assertion.title,
        });
      }
    }
    packages.push({
      name: result.package,
      wallMs: isFinite(minStart)
        ? Math.max(0, maxEnd - minStart)
        : result.elapsedMs,
      elapsedMs: result.elapsedMs,
      suiteCount: packageFiles.length,
      testCount: data.numTotalTests ?? 0,
      sumMs,
      nonPassedSuites,
      commandFailed: result.code !== 0 || result.timedOut,
    });
  }
  packages.sort((a, b) => b.wallMs - a.wallMs);
  files.sort((a, b) => b.ms - a.ms);
  tests.sort((a, b) => b.ms - a.ms);
  return {
    packages,
    files,
    tests,
    failures,
    slowFiles: files.filter((row) => row.ms >= opts.fileThresholdMs),
    slowTests: tests.filter((row) => row.ms >= opts.testThresholdMs),
  };
}

function printTable(title, rows, render, limit) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log("  none");
    return;
  }
  for (const row of rows.slice(0, limit)) {
    console.log(render(row));
  }
}

function printSummary(summary, opts) {
  printTable(
    "Package Timing",
    summary.packages,
    (row) =>
      `  ${row.name.padEnd(16)} wall=${formatMs(row.wallMs).padStart(7)} ` +
      `sum=${formatMs(row.sumMs).padStart(7)} suites=${String(row.suiteCount).padStart(4)} ` +
      `tests=${String(row.testCount).padStart(5)} ` +
      `${row.commandFailed ? "COMMAND_FAILED" : row.nonPassedSuites ? "HAS_FAILURES" : "ok"}`,
    summary.packages.length,
  );
  printTable(
    `Slowest Test Files (top ${opts.topFiles})`,
    summary.files,
    (row) =>
      `  ${formatMs(row.ms).padStart(7)} ${row.status.padEnd(8)} ` +
      `${row.package.padEnd(16)} ${row.file} (${row.testCount} tests)`,
    opts.topFiles,
  );
  printTable(
    `Slowest Individual Tests (top ${opts.topTests})`,
    summary.tests,
    (row) =>
      `  ${formatMs(row.ms).padStart(7)} ${row.status.padEnd(8)} ` +
      `${row.package.padEnd(16)} ${row.file} :: ${row.name}`.slice(0, 220),
    opts.topTests,
  );
  printTable(
    `Files Over Threshold (${formatMs(opts.fileThresholdMs)})`,
    summary.slowFiles,
    (row) =>
      `  ${formatMs(row.ms).padStart(7)} ${row.status.padEnd(8)} ` +
      `${row.package.padEnd(16)} ${row.file}`,
    summary.slowFiles.length,
  );
  printTable(
    `Individual Tests Over Threshold (${formatMs(opts.testThresholdMs)})`,
    summary.slowTests,
    (row) =>
      `  ${formatMs(row.ms).padStart(7)} ${row.status.padEnd(8)} ` +
      `${row.package.padEnd(16)} ${row.file} :: ${row.name}`.slice(0, 220),
    summary.slowTests.length,
  );
  printTable(
    "Non-Passing / Timeout Candidates",
    summary.failures,
    (row) =>
      `  ${formatMs(row.ms).padStart(7)} ${row.status.padEnd(14)} ` +
      `${row.package.padEnd(16)} ${row.file}`,
    summary.failures.length,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let packages = discoverPackages();
  if (opts.packages) {
    const selected = new Set(opts.packages);
    packages = packages.filter((pkg) => selected.has(pkg.name));
    const found = new Set(packages.map((pkg) => pkg.name));
    const missing = [...selected].filter((name) => !found.has(name));
    if (missing.length) {
      throw new Error(`unknown or non-Jest packages: ${missing.join(", ")}`);
    }
  }
  packages = packages.filter((pkg) => !opts.exclude.has(pkg.name));
  if (opts.listPackages) {
    for (const pkg of packages) {
      console.log(pkg.name);
    }
    return;
  }
  if (!packages.length) {
    throw new Error("no packages selected");
  }
  if (!opts.keepOutput && existsSync(opts.out)) {
    rmSync(opts.out, { recursive: true, force: true });
  }
  mkdirSync(opts.out, { recursive: true });
  console.log(`Writing audit JSON to ${opts.out}`);
  console.log(
    `Testing ${packages.length} package(s): ${packages.map((pkg) => pkg.name).join(", ")}`,
  );
  console.log(`Package concurrency: ${opts.concurrency}`);
  const started = Date.now();
  const results = await runWithConcurrency(packages, opts.concurrency, (pkg) =>
    runPackage(pkg, join(opts.out, `${pkg.name}.json`), opts),
  );
  const summary = aggregate(results, opts);
  printSummary(summary, opts);
  const elapsedMs = Date.now() - started;
  const commandFailures = results.filter(
    (result) => result.code !== 0 || result.timedOut,
  );
  console.log(`\nAudit completed in ${formatMs(elapsedMs)}.`);
  console.log(`JSON output: ${opts.out}`);
  if (commandFailures.length) {
    console.log(
      `Package commands with non-zero exit or timeout: ${commandFailures
        .map((result) => result.package)
        .join(", ")}`,
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
