const test = require("node:test");
const assert = require("node:assert/strict");
const { PATCHES, patchSource } = require("./patch-claude-agent-acp.cjs");

const byName = (name) => PATCHES.find((patch) => patch.name.startsWith(name));
const rateLimit = byName("rate_limit_event");
const steerPriority = byName("steer delivery");

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

test("delivers guidance at the next step instead of aborting Claude", () => {
  const priority = (openUserInputs) =>
    new Function(
      "session",
      "STEER_PRIORITY_LATER",
      "STEER_PRIORITY_NOW",
      `const userMessage = {};\n${steerPriority.patched}\nreturn userMessage.priority;`,
    )({ openUserInputs }, "later", "now");
  assert.equal(priority(new Map()), "next");
  assert.equal(priority(undefined), "next");
  // A pending permission prompt still defers guidance until it settles.
  assert.equal(priority(new Map([["request-1", {}]])), "later");
});
