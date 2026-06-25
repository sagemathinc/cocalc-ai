#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const cwd = process.cwd();
const testRoot = path.join(cwd, "build", "test");
const testDataRoot = path.join(cwd, "build", "test-data");

function listCompiledTests(dir = testRoot) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return listCompiledTests(file);
      }
      return entry.isFile() && entry.name.endsWith(".test.js") ? [file] : [];
    })
    .sort();
}

function withoutTypeScriptExtension(file) {
  return file.replace(/\.(ts|tsx|mts|cts)$/, ".js");
}

function normalizePathArg(arg) {
  const absolute = path.isAbsolute(arg) ? arg : path.resolve(cwd, arg);
  let relative = path.relative(cwd, absolute);
  if (relative.startsWith("..")) {
    throw new Error(`test path must be inside ${cwd}: ${arg}`);
  }
  relative = relative.split(path.sep).join("/");
  if (relative.startsWith("build/test/")) {
    return path.resolve(cwd, withoutTypeScriptExtension(relative));
  }
  if (relative.startsWith("src/")) {
    return path.resolve(
      cwd,
      "build/test/cli",
      withoutTypeScriptExtension(relative),
    );
  }
  if (relative.startsWith("cli/src/")) {
    return path.resolve(
      cwd,
      "build/test",
      withoutTypeScriptExtension(relative),
    );
  }
  return path.resolve(cwd, withoutTypeScriptExtension(relative));
}

const nodeTestArgs = [];
const explicitTests = [];

for (const arg of process.argv.slice(2)) {
  if (arg.startsWith("-")) {
    nodeTestArgs.push(arg);
    continue;
  }
  const testFile = normalizePathArg(arg);
  if (!fs.existsSync(testFile)) {
    throw new Error(`compiled test not found for '${arg}' at ${testFile}`);
  }
  explicitTests.push(testFile);
}

const tests = explicitTests.length > 0 ? explicitTests : listCompiledTests();
if (tests.length === 0) {
  throw new Error(`no compiled tests found under ${testRoot}`);
}

const result = spawnSync(
  process.execPath,
  ["--test", ...nodeTestArgs, ...tests],
  {
    env: {
      ...process.env,
      COCALC_BROWSER_SESSION_STATE_DIR:
        process.env.COCALC_BROWSER_SESSION_STATE_DIR ||
        path.join(testDataRoot, "browser-sessions"),
    },
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
