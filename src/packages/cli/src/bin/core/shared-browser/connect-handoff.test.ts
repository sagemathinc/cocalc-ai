/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { localForwardSshArgs } from "../reverse-tunnel";
import {
  driverForKey,
  handoffApi,
  handoffMessages,
  notifyDesktop,
  startHandoff,
  type HandoffState,
} from "./connect-handoff";

const agent: HandoffState = { driver: "agent", ask: null, agentWaiting: false };

test("says who drives when it changes, and what the agent asks", () => {
  assert.deepEqual(handoffMessages(null, agent), [
    "The agent is driving. Press t to take over.",
  ]);
  assert.deepEqual(handoffMessages(agent, agent), []);
  const asked = { ...agent, ask: { message: "Please log in", at: "1" } };
  assert.deepEqual(handoffMessages(agent, asked), [
    "The agent asks you to take over: Please log in (press t)",
  ]);
  // The same request is said once.
  assert.deepEqual(handoffMessages(asked, asked), []);
  const human = { driver: "human" as const, ask: null, agentWaiting: true };
  assert.deepEqual(handoffMessages(agent, human), [
    "You're driving: the agent waits. Press h to hand back.",
    "The agent is waiting for you to hand back (press h).",
  ]);
});

test("t takes over and h hands back; other keys do nothing", () => {
  assert.equal(driverForKey("t"), "human");
  assert.equal(driverForKey("H"), "agent");
  assert.equal(driverForKey("x"), undefined);
});

test("keys set the driver on the service, and its state is reported", async () => {
  // A stand-in for the .browser file's service API.
  let state: HandoffState = { ...agent };
  const posted: unknown[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/driver") {
        const { driver } = JSON.parse(body);
        posted.push(driver);
        state = { ...state, driver };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(state));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const said: string[] = [];
  const notified: string[] = [];
  const handoff = startHandoff({
    api: handoffApi(port),
    say: (line) => said.push(line),
    notify: (_title, body) => notified.push(body),
    intervalMs: 60_000,
  });
  try {
    await handoff.poll();
    assert.deepEqual(said, ["The agent is driving. Press t to take over."]);
    await handoff.key("t");
    assert.deepEqual(posted, ["human"]);
    assert.equal(
      said.at(-1),
      "You're driving: the agent waits. Press h to hand back.",
    );
    await handoff.key("q");
    assert.deepEqual(posted, ["human"]);
    await handoff.key("h");
    assert.deepEqual(posted, ["human", "agent"]);
    // The agent asks: said, and a desktop notification.
    state = { ...state, ask: { message: "Solve the captcha", at: "2" } };
    await handoff.poll();
    assert.match(said.at(-1)!, /asks you to take over: Solve the captcha/);
    assert.deepEqual(notified, ["Solve the captcha"]);
  } finally {
    handoff.stop();
    server.close();
  }
});

test("an unreachable service is reported once, and the recovery too", async () => {
  const said: string[] = [];
  let up = false;
  const handoff = startHandoff({
    api: {
      state: async () => {
        if (!up) throw new Error("connection refused");
        return agent;
      },
      setDriver: async () => agent,
    },
    say: (line) => said.push(line),
    intervalMs: 60_000,
  });
  try {
    await handoff.poll();
    await handoff.poll();
    assert.equal(said.length, 1);
    assert.match(said[0], /unavailable for now \(connection refused\)/);
    up = true;
    await handoff.poll();
    assert.deepEqual(said.slice(1), [
      "The agent is driving. Press t to take over.",
      "Hand-off controls are back.",
    ]);
  } finally {
    handoff.stop();
  }
});

test("the service is forwarded to loopback only, tied to this process", () => {
  assert.deepEqual(
    localForwardSshArgs({
      alias: "p",
      projectPort: 4000,
      localPort: 5000,
    }).slice(-4),
    ["-L", "127.0.0.1:5000:127.0.0.1:4000", "p", "cat >/dev/null"],
  );
});

test("desktop notifications use the system's notifier, where there is one", () => {
  const runs: unknown[][] = [];
  const run = ((command: string, args: string[]) => {
    runs.push([command, ...args]);
    return { on: () => {}, unref: () => {} };
  }) as any;
  notifyDesktop("T", "B", "linux", run);
  notifyDesktop("T", 'say "hi"', "darwin", run);
  notifyDesktop("T", "B", "win32", run);
  assert.deepEqual(runs, [
    ["notify-send", "T", "B"],
    ["osascript", "-e", 'display notification "say \\"hi\\"" with title "T"'],
  ]);
});
