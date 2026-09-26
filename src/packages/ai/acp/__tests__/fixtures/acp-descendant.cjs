// Disposable-container qualification only. Deliberately ignores cancellation
// and leaves a detached child for the launcher to terminate with the container.
// Usage: node acp-descendant.cjs /absolute/path/to/heartbeat.json
const { spawn } = require("node:child_process");
const heartbeat = process.argv[2];
if (!heartbeat?.startsWith("/")) throw Error("Pass an absolute heartbeat path");
const child = spawn(
  process.execPath,
  [
    "-e",
    `
      const {writeFileSync} = require('node:fs');
      let count = 0;
      process.on('SIGTERM', () => {});
      const beat = () => writeFileSync(process.argv[1], JSON.stringify({
        pid: process.pid, count: ++count, at: Date.now()
      }));
      beat();
      const timer = setInterval(beat, 200);
      // Safety bound if a test's cleanup fails; not evidence of launcher cleanup.
      setTimeout(() => { clearInterval(timer); process.exit(0); }, 300000);
    `,
    heartbeat,
  ],
  { detached: true, stdio: "ignore" },
);
child.on("error", () => process.exit(1));
child.unref();
process.argv.push("--ignore-cancel");
require("./acp-harness.cjs");
