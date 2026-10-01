jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(),
}));
import {
  AGENT_MEMORY_RATE_LIMITS,
  agentMemoryLimitExceeded,
  chargeAgentMemoryUsage,
  isAgentActor,
  isAgentMemorySelector,
} from "./memory-limits";

// A shared table standing in for the home bay's agent_memory_usage row, with
// the same fixed-window semantics as the SQL upsert.
function sharedTable() {
  const rows = new Map<string, any>();
  let now = 1_000_000;
  const query = async (
    _sql: string,
    [account, reads, writes, bytes]: any[],
  ) => {
    const row = rows.get(account);
    if (!row) {
      const fresh = {
        minute_start: now,
        minute_reads: reads,
        minute_writes: writes,
        hour_start: now,
        hour_bytes: bytes,
      };
      rows.set(account, fresh);
      return { rows: [fresh] };
    }
    const inMinute = row.minute_start > now - 60_000;
    const inHour = row.hour_start > now - 3_600_000;
    row.minute_reads = inMinute ? row.minute_reads + reads : reads;
    row.minute_writes = inMinute ? row.minute_writes + writes : writes;
    row.minute_start = inMinute ? row.minute_start : now;
    row.hour_bytes = inHour ? row.hour_bytes + bytes : bytes;
    row.hour_start = inHour ? row.hour_start : now;
    return { rows: [row] };
  };
  return { query, advance: (ms: number) => (now += ms) };
}

test("limits are shared by every caller of the same table and reset by window", async () => {
  const { query, advance } = sharedTable();
  // Two "hub processes" share one counter row.
  for (let i = 0; i < AGENT_MEMORY_RATE_LIMITS.readsPerMinute; i++)
    await chargeAgentMemoryUsage("a", "read", 0, query);
  await expect(chargeAgentMemoryUsage("a", "read", 0, query)).rejects.toThrow(
    /read rate limit/,
  );
  // Rejected attempts still count; other accounts are unaffected.
  await expect(chargeAgentMemoryUsage("a", "read", 0, query)).rejects.toThrow();
  await chargeAgentMemoryUsage("b", "read", 0, query);
  advance(61_000);
  await chargeAgentMemoryUsage("a", "read", 0, query);
});

test("enforces the write rate and the hourly byte budget", async () => {
  const { query, advance } = sharedTable();
  for (let i = 0; i < AGENT_MEMORY_RATE_LIMITS.writesPerMinute; i++)
    await chargeAgentMemoryUsage("c", "write", 10, query);
  await expect(chargeAgentMemoryUsage("c", "write", 10, query)).rejects.toThrow(
    /write rate limit/,
  );
  await chargeAgentMemoryUsage(
    "d",
    "write",
    AGENT_MEMORY_RATE_LIMITS.writtenBytesPerHour,
    query,
  );
  advance(61_000);
  await expect(chargeAgentMemoryUsage("d", "write", 1, query)).rejects.toThrow(
    /hourly/,
  );
});

test("decision helpers", () => {
  expect(
    agentMemoryLimitExceeded({
      minute_reads: 1,
      minute_writes: 1,
      hour_bytes: "10",
    }),
  ).toBeUndefined();
  expect(isAgentActor({ actor: "agent" })).toBe(true);
  expect(isAgentActor({ actor: "owner" })).toBe(false);
  expect(isAgentActor(undefined)).toBe(false);
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
