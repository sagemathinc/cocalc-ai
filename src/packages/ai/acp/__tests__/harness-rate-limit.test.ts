import { takeRateLimit } from "../harness-rate-limit";

test("subscription limits are split off an ACP update, not persisted", () => {
  const rateLimit = { status: "allowed", utilization: 0.4 };
  const update = {
    sessionUpdate: "usage_update",
    used: 10,
    size: 100,
    _meta: { "_claude/rateLimit": rateLimit, "_claude/model": "opus" },
  };
  expect(takeRateLimit(update)).toEqual({
    update: {
      sessionUpdate: "usage_update",
      used: 10,
      size: 100,
      _meta: { "_claude/model": "opus" },
    },
    rateLimit,
  });
  // The original update is not modified.
  expect(update._meta["_claude/rateLimit"]).toBe(rateLimit);
});

test("updates without limits pass through unchanged", () => {
  const update = { sessionUpdate: "tool_call", _meta: { other: 1 } };
  expect(takeRateLimit(update)).toEqual({ update });
  expect(takeRateLimit({ sessionUpdate: "plan" })).toEqual({
    update: { sessionUpdate: "plan" },
  });
});
