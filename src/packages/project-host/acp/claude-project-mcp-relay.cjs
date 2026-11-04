// @ts-check
/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
/* Trusted controller-side transport for one of the user's MCP servers: its
 * stdio relayed, unchanged, over the scoped socket to the project host, which
 * runs the server inside the project and decides what it may ask of Claude.
 * Usage: node relay.cjs <server name> */
const fs = require("node:fs");
const net = require("node:net");
const root = process.env.COCALC_PROJECT_TOOL_DIR || "/run/cocalc/agent-tools";
const token = fs.readFileSync(root + "/token", "utf8");
const name = process.argv[2] || "";
const socket = net.connect(root + "/tool.sock");
socket.on("connect", () => {
  // The first line names the server; everything after is MCP traffic.
  socket.write(JSON.stringify({ token, mcp: name }) + "\n");
  process.stdin.pipe(socket);
});
socket.pipe(process.stdout);
socket.on("close", () => process.exit(0));
socket.on("error", (error) => {
  process.stderr.write(`cocalc MCP relay (${name}): ${error.message}\n`);
  process.exit(1);
});
process.stdin.on("end", () => socket.end());
module.exports = {};
