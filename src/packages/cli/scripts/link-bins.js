#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const binDir = path.join(root, "node_modules", ".bin");
const target = path.join("..", "..", "dist", "bin", "cocalc.js");
const targetPath = path.join(root, "dist", "bin", "cocalc.js");
const names = ["cocalc", "cocalc-cli", "cli"];

fs.mkdirSync(binDir, { recursive: true });
if (fs.existsSync(targetPath)) {
  fs.chmodSync(targetPath, 0o755);
}

for (const name of names) {
  const linkPath = path.join(binDir, name);
  try {
    fs.unlinkSync(linkPath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
  fs.symlinkSync(target, linkPath);
}
