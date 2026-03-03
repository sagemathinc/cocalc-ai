#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const entry = path.join(root, "dist", "bin", "cocalc.js");

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if ((res.status ?? 1) !== 0) {
    process.exit(res.status ?? 1);
  }
}

if (fs.existsSync(entry)) {
  process.exit(0);
}

console.warn(
  "cli build output missing (dist/bin/cocalc.js); forcing TypeScript rebuild to refresh stale tsbuildinfo",
);
run("pnpm", ["exec", "tsc", "--build", "--force"]);

if (!fs.existsSync(entry)) {
  console.error(`ERROR: expected build output missing: ${entry}`);
  process.exit(1);
}

