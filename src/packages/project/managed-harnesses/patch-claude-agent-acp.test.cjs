const test = require("node:test");
const assert = require("node:assert/strict");
const { ORIGINAL, PATCHED, patchSource } = require("./patch-claude-agent-acp.cjs");

const before = `switch (message.type) {\n${ORIGINAL}\n}`;

test("forwards rate limits even before the first assistant message", () => {
  const after = patchSource(before);
  assert.ok(after.includes(PATCHED));
  assert.ok(!after.includes("if (lastAssistantTotalUsage !== null) {"));
  assert.ok(after.includes('"_claude/rateLimit": message.rate_limit_info'));
});

test("is idempotent and refuses an unknown adapter version", () => {
  assert.equal(patchSource(patchSource(before)), patchSource(before));
  assert.throws(() => patchSource("switch (x) {}"), /not found exactly once/);
  assert.throws(() => patchSource(before + before), /not found exactly once/);
});
