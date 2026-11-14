import {
  createAgentTurnUsageRecorder,
  MAX_TURN_USAGE_BATCH,
  type TurnUsageReport,
} from "./agent-turn-usage";

const OWNER = "00000000-0000-4000-8000-000000000002";
const usage = (thread_id = "t1") => ({
  project_id: "00000000-0000-4000-8000-000000000001",
  path: "a.chat",
  thread_id,
  provider: "codex" as const,
  payment: "subscription",
  models: [
    {
      model: "gpt",
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  ],
  started_at: 1,
  ended_at: 2,
  outcome: "completed" as const,
});

describe("createAgentTurnUsageRecorder", () => {
  it("batches turns and sends them once", async () => {
    const batches: TurnUsageReport[][] = [];
    const record = createAgentTurnUsageRecorder({
      write: async (reports) => {
        batches.push(reports);
      },
      flushMs: 60_000,
    });
    for (let i = 0; i < MAX_TURN_USAGE_BATCH + 3; i++)
      record(OWNER, usage(`t${i}`));
    expect(record.size()).toBe(MAX_TURN_USAGE_BATCH + 3);
    await record.flush();
    expect(batches.map((b) => b.length)).toEqual([MAX_TURN_USAGE_BATCH, 3]);
    expect(batches[0][0]).toEqual({ owner_account_id: OWNER, usage: usage("t0") });
    expect(record.size()).toBe(0);
  });

  it("drops invalid turns and owners", async () => {
    const write = jest.fn(async () => {});
    const record = createAgentTurnUsageRecorder({ write, flushMs: 60_000 });
    record("not-a-uuid", usage());
    record(OWNER, { ...usage(), models: [] });
    await record.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("never throws when the hub is unreachable", async () => {
    const record = createAgentTurnUsageRecorder({
      write: async () => {
        throw Error("no hub");
      },
      flushMs: 60_000,
    });
    record(OWNER, usage());
    await expect(record.flush()).resolves.toBeUndefined();
    expect(record.size()).toBe(0);
  });

  it("sends on its own after the interval", async () => {
    const write = jest.fn(async () => {});
    const record = createAgentTurnUsageRecorder({ write, flushMs: 5 });
    record(OWNER, usage());
    await new Promise((r) => setTimeout(r, 30));
    expect(write).toHaveBeenCalledTimes(1);
  });
});
