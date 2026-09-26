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
  let background = false;
  if (!stopped) {
    try { process.kill(-child.pid, 0); background = true; }
    // This is only a diagnostic probe. Unknown membership must not skip kill().
    catch {}
  }
  kill();
  if (background) require("node:fs").writeSync(2,
    "Background processes were terminated when the command exited; use cocalc project terminal spawn for persistent services.\n");
  clearInterval(timer);
  process.exit(stopped ? 130 : code ?? 1);
});
`;

// Verify the *exec process*, not merely its host launcher, before project code
// can fork. An OCI runtime that moves exec into the main container cgroup must
// fail closed rather than quietly lose per-job containment.
export const MANAGED_SANDBOX_COMMAND_SUPERVISOR =
  String.raw`
const scope = process.env.COCALC_MANAGED_JOB_SCOPE;
const cgroup = require("node:fs").readFileSync("/proc/self/cgroup", "utf8");
if (!/^job-\d+-\d+-\d+-\d+-\d+-[0-9a-f-]{36}$/.test(scope ?? "") ||
    !cgroup.split("\n").some(line => line.startsWith("0::") && line.endsWith("/" + scope))) {
  process.stderr.write("Managed project command containment unavailable\n");
  process.exit(125);
}
` + SANDBOX_COMMAND_SUPERVISOR;
