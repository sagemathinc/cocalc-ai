#!/usr/bin/env node

const indexArg = process.argv[2];
const index = indexArg === undefined ? 0 : Number(indexArg);
if (!Number.isInteger(index) || index < 0) {
  console.error(
    `Invalid instance index "${indexArg}". Provide a non-negative integer (e.g., 0, 1, 2).`,
  );
  process.exit(1);
}

const { startHostAgent } = require("../dist/daemon.js");

try {
  startHostAgent(index);
} catch (err) {
  console.error(`${err}`);
  process.exit(1);
}
