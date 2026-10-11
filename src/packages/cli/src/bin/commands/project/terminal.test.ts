import assert from "node:assert/strict";
import test from "node:test";

import {
  agentTerminalId,
  assertProjectTerminalRuntimeAvailable,
  killTerminalSession,
} from "./terminal";

test("assertProjectTerminalRuntimeAvailable rejects known non-runtime states", () => {
  assert.doesNotThrow(() =>
    assertProjectTerminalRuntimeAvailable({ project: { state: null } }),
  );
  assert.doesNotThrow(() =>
    assertProjectTerminalRuntimeAvailable({
      project: { state: { state: "running" } },
    }),
  );
  assert.throws(
    () =>
      assertProjectTerminalRuntimeAvailable({
        project: { state: { state: "opened" } },
      }),
    /project terminal operations are unavailable because the project is opened/,
  );
});

test("an agent's terminal is a hidden file next to its chat, one per thread", () => {
  assert.equal(
    agentTerminalId("/home/user/.local/share/cocalc/agents/a.chat", "t1"),
    "/home/user/.local/share/cocalc/agents/.a.chat-t1.term",
  );
  assert.notEqual(
    agentTerminalId("/home/user/a.chat", "t1"),
    agentTerminalId("/home/user/a.chat", "t2"),
  );
});

test("killTerminalSession attaches and destroys a running session", async () => {
  const calls: string[] = [];
  const terminal = {
    state: async () => "running" as const,
    attach: async (id: string, options?: { historyLimit?: number }) => {
      calls.push(`attach ${id} ${options?.historyLimit}`);
      return "";
    },
    destroy: async () => {
      calls.push("destroy");
    },
  };
  assert.deepEqual(await killTerminalSession(terminal, "job-1"), {
    id: "job-1",
    killed: true,
  });
  assert.deepEqual(calls, ["attach job-1 1", "destroy"]);
});

test("killTerminalSession leaves a session that is not running alone", async () => {
  const calls: string[] = [];
  const terminal = {
    state: async () => "off" as const,
    attach: async () => {
      calls.push("attach");
      return "";
    },
    destroy: async () => {
      calls.push("destroy");
    },
  };
  assert.deepEqual(await killTerminalSession(terminal, "gone"), {
    id: "gone",
    killed: false,
    reason: "terminal is not running",
  });
  assert.deepEqual(calls, []);
});
