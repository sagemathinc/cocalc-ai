#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

if (process.platform === "darwin") {
  console.log("Skipping @cocalc/project-host tests on macOS");
  process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(pnpm, ["exec", "jest", "--config", "jest.config.js"], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 0);
