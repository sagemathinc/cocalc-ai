import assert from "node:assert/strict";
import test from "node:test";

import {
  agentTerminalId,
  assertProjectTerminalRuntimeAvailable,
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
