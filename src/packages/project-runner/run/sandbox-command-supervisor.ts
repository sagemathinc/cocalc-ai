/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Runs inside the project. A short stdin lease prevents an orphan command when
// the host or Podman client disappears without delivering a signal in-container.
export const SANDBOX_COMMAND_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
let child;
let stopped = false;
let lastHeartbeat = Date.now();
const kill = () => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
};
const stop = () => {
  if (stopped) return;
  stopped = true;
  kill();
};
const timer = setInterval(() => {
  if (Date.now() - lastHeartbeat > 5000) stop();
}, 1000);
process.stdin.on("data", () => { lastHeartbeat = Date.now(); });
process.stdin.on("end", stop);
process.stdin.on("error", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child = spawn("/bin/bash", ["-lc", process.argv[1]], {
  detached: true, stdio: ["ignore", "inherit", "inherit"]
});
child.once("error", () => { clearInterval(timer); process.exit(1); });
child.once("exit", (code) => {
  kill();
  clearInterval(timer);
  process.exit(stopped ? 130 : code ?? 1);
});
`;
