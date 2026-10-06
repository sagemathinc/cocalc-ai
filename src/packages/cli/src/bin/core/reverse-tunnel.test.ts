import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";

import { reverseTunnelSshArgs, startReverseTunnel } from "./reverse-tunnel";

// Stand-in for ssh: a node process running `script`.
const fake = (script: string) => () =>
  spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "ignore", "pipe"],
  });

test("binds loopback in the project and ties ssh to a lifetime pipe", () => {
  assert.deepEqual(
    reverseTunnelSshArgs({
      alias: "cocalc-project-6adb0c79",
      projectPort: 9222,
      localPort: 41234,
    }),
    [
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=2",
      "-R",
      "127.0.0.1:9222:127.0.0.1:41234",
      "cocalc-project-6adb0c79",
      "cat >/dev/null",
    ],
  );
  assert.ok(
    reverseTunnelSshArgs({
      alias: "a",
      projectPort: 1,
      localPort: 2,
      compress: true,
    }).includes("-C"),
  );
});

test("gives up at once when the project refuses the forward", async () => {
  let spawns = 0;
  const tunnel = startReverseTunnel({
    args: [],
    spawnSsh: () => {
      spawns++;
      return fake(
        "process.stderr.write('Error: remote port forwarding failed for listen port 9222\\n'); process.exit(255)",
      )();
    },
  });
  const err = await tunnel.failed;
  assert.match(err.message, /refused the tunnel .*already in use/);
  assert.equal(spawns, 1);
  await tunnel.stop();
});

test("gives up at once on authentication failures", async () => {
  const tunnel = startReverseTunnel({
    args: [],
    spawnSsh: fake(
      "process.stderr.write('user@host: Permission denied (publickey).\\n'); process.exit(255)",
    ),
  });
  assert.match((await tunnel.failed).message, /ssh to the project failed/);
});

test("reconnects when the connection drops, then gives up if it keeps failing", async () => {
  let spawns = 0;
  const statuses: string[] = [];
  const tunnel = startReverseTunnel({
    args: [],
    reconnectDelaysMs: [10],
    onStatus: (message) => statuses.push(message),
    spawnSsh: () => {
      spawns++;
      return fake(
        "process.stderr.write('Connection reset by peer\\n'); process.exit(255)",
      )();
    },
  });
  const err = await tunnel.failed;
  assert.match(err.message, /could not keep the ssh tunnel up/);
  assert.equal(spawns, 6);
  assert.equal(statuses.length, 5);
  assert.match(statuses[0], /dropped .*reconnecting/);
});

test("stop ends the current ssh and prevents reconnecting", async () => {
  let spawns = 0;
  const tunnel = startReverseTunnel({
    args: [],
    reconnectDelaysMs: [10],
    spawnSsh: () => {
      spawns++;
      return fake("setInterval(() => {}, 1000)")();
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  await tunnel.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(spawns, 1);
});

test("ssh's stdin stays open as the lifetime pipe", async () => {
  // The fake exits as soon as its stdin closes, like the remote `cat`.
  const tunnel = startReverseTunnel({
    args: [],
    reconnectDelaysMs: [10],
    spawnSsh: fake(
      "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()",
    ),
  });
  const outcome = await Promise.race([
    tunnel.failed.then(() => "failed"),
    new Promise((r) => setTimeout(() => r("still up"), 1500)),
  ]);
  assert.equal(outcome, "still up");
  await tunnel.stop();
});
