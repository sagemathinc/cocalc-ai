const test = require("node:test");
const assert = require("node:assert/strict");
const { PATCHES, patchSource } = require("./patch-claude-agent-acp.cjs");

const byName = (name) => PATCHES.find((patch) => patch.name.startsWith(name));
const rateLimit = byName("rate_limit_event");
const recording = byName("assistant message");
const endOfTurn = byName("end-of-turn");

const before = PATCHES.map(({ original }) => original).join("\n// ...\n");

test("forwards rate limits even before the first assistant message", () => {
  const after = patchSource(before);
  assert.ok(after.includes(rateLimit.patched));
  assert.ok(!after.includes("if (lastAssistantTotalUsage !== null) {"));
  assert.ok(after.includes('"_claude/rateLimit": message.rate_limit_info'));
});

test("is idempotent and refuses an unknown adapter version", () => {
  assert.equal(patchSource(patchSource(before)), patchSource(before));
  assert.throws(() => patchSource("switch (x) {}"), /not found exactly once/);
  assert.throws(() => patchSource(before + before), /not found exactly once/);
  for (const { original } of PATCHES) {
    assert.throws(
      () => patchSource(before.replace(original, "")),
      /not found exactly once/,
    );
  }
});

const AsyncFunction = (async () => {}).constructor;

// Run the patched adapter code with stubs for the surrounding scope.
function recordAssistantMessage(session, message) {
  new Function(
    "session",
    "message",
    `switch (0) { case 0:\n${recording.patched}\n}`,
  )(session, message);
}

async function endTurn({ session, turn, background = [] }) {
  const updates = [];
  const logged = [];
  const run = new AsyncFunction(
    "session",
    "turn",
    "params",
    "result",
    "backgroundTools",
    "unregisterHookCallback",
    "sendUpdate",
    "settleActive",
    `${endOfTurn.patched}
        return { failsTurn: true, unfinished };
    }
    return { failsTurn: false, unfinished };`,
  );
  const outcome = await run.call(
    { logger: { error: (line) => logged.push(line) } },
    session,
    turn,
    { sessionId: "session-1" },
    { stopReason: "end_turn" },
    new Set(background),
    () => {},
    async ({ update }) => updates.push(update),
    async () => {},
  );
  return { ...outcome, updates, logged };
}

function newSession() {
  const turn = { promptUuid: "prompt-1", settled: false };
  return {
    turn,
    session: {
      activeTurn: turn,
      turnQueue: [turn],
      cancelled: false,
      emittedToolCalls: new Set(),
      toolUseCache: {},
      toolCallFields: new Map(),
    },
  };
}

function announce(session, id) {
  session.emittedToolCalls.add(id);
  (session.activeTurn.foregroundToolCallIds ??= new Set()).add(id);
}

test("does not fail a turn whose steer stranded a streamed tool call", async () => {
  const { session, turn } = newSession();
  // Ran normally: in an assistant message, result received.
  announce(session, "ran");
  recordAssistantMessage(session, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "ran", input: {} }] },
  });
  session.emittedToolCalls.delete("ran");
  // Streamed, then the steer aborted the cycle: never in an assistant message.
  announce(session, "stranded");

  const { failsTurn, unfinished, updates, logged } = await endTurn({
    session,
    turn,
  });
  assert.equal(failsTurn, false);
  assert.deepEqual(unfinished, []);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].toolCallId, "stranded");
  assert.equal(updates[0].status, "failed");
  assert.match(updates[0].content[0].content.text, /Not run/);
  assert.equal(session.emittedToolCalls.has("stranded"), false);
  assert.equal(turn.foregroundToolCallIds.has("stranded"), false);
  assert.match(logged[0], /stranded was interrupted before it ran/);
});

test("still fails a turn when a tool Claude ran lost its result", async () => {
  const { session, turn } = newSession();
  announce(session, "lost");
  recordAssistantMessage(session, {
    type: "assistant",
    message: { content: [{ type: "mcp_tool_use", id: "lost", input: {} }] },
  });

  const { failsTurn, unfinished, updates } = await endTurn({ session, turn });
  assert.equal(failsTurn, true);
  assert.deepEqual(unfinished, ["lost"]);
  assert.deepEqual(updates, []);
});

test("leaves background tools and user messages alone", async () => {
  const { session, turn } = newSession();
  announce(session, "background");
  recordAssistantMessage(session, {
    type: "user",
    message: { content: [{ type: "tool_use", id: "background" }] },
  });
  assert.equal(turn.finalizedToolUseIds, undefined);

  const { failsTurn, updates } = await endTurn({
    session,
    turn,
    background: ["background"],
  });
  assert.equal(failsTurn, false);
  assert.deepEqual(updates, []);
});
