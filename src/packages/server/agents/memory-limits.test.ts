import {
  AGENT_MEMORY_RATE_LIMITS,
  checkAgentMemoryAccess,
  isAgentMemorySelector,
  resetAgentMemoryLimits,
} from "./memory-limits";

beforeEach(() => resetAgentMemoryLimits());

test("enforces per-account read and write rates and the hourly byte budget", () => {
  const now = 1_000_000;
  for (let i = 0; i < AGENT_MEMORY_RATE_LIMITS.readsPerMinute; i++)
    checkAgentMemoryAccess("a", "read", 0, now);
  expect(() => checkAgentMemoryAccess("a", "read", 0, now)).toThrow(
    /rate limit/,
  );
  // Other accounts are unaffected, and the window slides.
  checkAgentMemoryAccess("b", "read", 0, now);
  checkAgentMemoryAccess("a", "read", 0, now + 61_000);
  for (let i = 0; i < AGENT_MEMORY_RATE_LIMITS.writesPerMinute; i++)
    checkAgentMemoryAccess("c", "write", 10, now);
  expect(() => checkAgentMemoryAccess("c", "write", 10, now)).toThrow(
    /rate limit/,
  );
  checkAgentMemoryAccess(
    "d",
    "write",
    AGENT_MEMORY_RATE_LIMITS.writtenBytesPerHour - 1,
    now,
  );
  expect(() => checkAgentMemoryAccess("d", "write", 2, now + 120_000)).toThrow(
    /hourly/,
  );
});

test("matches only the agent-memory selector", () => {
  expect(
    isAgentMemorySelector({
      provider: "cocalc",
      kind: "agent-memory",
      scope: "account",
    }),
  ).toBe(true);
  expect(
    isAgentMemorySelector({
      provider: "anthropic",
      kind: "agent-memory",
      scope: "account",
    }),
  ).toBe(false);
});
