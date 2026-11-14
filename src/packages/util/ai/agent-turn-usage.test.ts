import {
  claudeTurnModelUsage,
  codexTurnModelUsage,
  mergeTurnModelUsage,
  parseAgentTurnUsage,
  totalTurnTokens,
} from "./agent-turn-usage";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const NOW = Date.now();
const CREDENTIAL = "00000000-0000-4000-8000-000000000003";

const turn = (over: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  path: ".local/share/cocalc/agents/a.chat",
  thread_id: "t1",
  provider: "claude",
  payment: "account-subscription",
  credential_id: CREDENTIAL,
  pool: true,
  models: [
    {
      model: "claude-opus-5-5",
      input_tokens: 10,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
      output_tokens: 50,
      reasoning_output_tokens: 0,
    },
  ],
  started_at: NOW - 60_000,
  ended_at: NOW - 1_000,
  outcome: "completed",
  ...over,
});

describe("parseAgentTurnUsage", () => {
  it("keeps a valid turn", () => {
    const parsed = parseAgentTurnUsage(turn());
    expect(parsed).toEqual(turn());
    expect(totalTurnTokens(parsed!)).toBe(1260);
  });

  it("drops what it does not know and bounds numbers", () => {
    const parsed = parseAgentTurnUsage(
      turn({
        prompt: "never stored",
        pool: "yes",
        models: [
          {
            model: "m",
            input_tokens: -5,
            cached_input_tokens: 1e20,
            output_tokens: 2.7,
            secret: "x",
          },
        ],
      }),
    );
    expect(parsed).not.toHaveProperty("prompt");
    expect(parsed).not.toHaveProperty("pool");
    expect(parsed!.models).toEqual([
      {
        model: "m",
        input_tokens: 0,
        cached_input_tokens: 1e12,
        cache_write_tokens: 0,
        output_tokens: 2,
        reasoning_output_tokens: 0,
      },
    ]);
  });

  it("rejects malformed turns", () => {
    for (const bad of [
      turn({ project_id: "nope" }),
      turn({ provider: "gemini" }),
      turn({ outcome: "great" }),
      turn({ credential_id: "not-a-uuid" }),
      turn({ ended_at: NOW - 120_000 }),
      turn({ path: "" }),
      turn({ models: [] }),
      turn({ models: [{ model: "m", output_tokens: 0 }] }),
      null,
      [],
    ])
      expect(parseAgentTurnUsage(bad)).toBeUndefined();
  });
});

describe("parseAgentTurnUsage time bounds", () => {
  it("refuses times a host could use to dodge retention or break storage", () => {
    const hour = 60 * 60_000;
    const day = 24 * hour;
    for (const [started_at, ended_at] of [
      // Far in the future: would never age out.
      [NOW + 365 * day - 1000, NOW + 365 * day],
      // Just past the skew allowance.
      [NOW + 11 * 60_000, NOW + 11 * 60_000],
      // Outside any database timestamp range.
      [Number.MAX_VALUE, Number.MAX_VALUE],
      [-Number.MAX_VALUE, NOW],
      // Too old, or an impossibly long turn.
      [NOW - 31 * day, NOW - 31 * day + 1000],
      [NOW - 8 * day, NOW],
    ])
      expect(
        parseAgentTurnUsage(turn({ started_at, ended_at }), NOW),
      ).toBeUndefined();
  });

  it("allows some clock skew and late reports", () => {
    expect(
      parseAgentTurnUsage(turn({ started_at: NOW, ended_at: NOW + 5 * 60_000 }), NOW),
    ).toBeDefined();
    const day = 24 * 60 * 60_000;
    expect(
      parseAgentTurnUsage(
        turn({ started_at: NOW - 20 * day, ended_at: NOW - 19 * day }),
        NOW,
      ),
    ).toBeDefined();
  });
});

describe("claudeTurnModelUsage", () => {
  it("reads claude-agent-acp's per-model quota metadata", () => {
    expect(
      claudeTurnModelUsage({
        stopReason: "end_turn",
        usage: { inputTokens: 99, outputTokens: 99 },
        _meta: {
          quota: {
            token_count: { totalTokens: 1 },
            model_usage: [
              {
                model: "claude-opus-5-5",
                token_count: {
                  inputTokens: 10,
                  cachedInputTokens: 1000,
                  cachedWriteTokens: 200,
                  outputTokens: 50,
                  reasoningOutputTokens: 0,
                },
              },
              {
                model: "claude-haiku-5-5",
                token_count: { inputTokens: 5, outputTokens: 1 },
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        model: "claude-opus-5-5",
        input_tokens: 10,
        cached_input_tokens: 1000,
        cache_write_tokens: 200,
        output_tokens: 50,
        reasoning_output_tokens: 0,
      },
      {
        model: "claude-haiku-5-5",
        input_tokens: 5,
        cached_input_tokens: 0,
        cache_write_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    ]);
  });

  it("falls back to the response's usage totals", () => {
    expect(
      claudeTurnModelUsage({
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cachedReadTokens: 5,
          cachedWriteTokens: 6,
        },
      }),
    ).toEqual([
      {
        model: "unknown",
        input_tokens: 3,
        cached_input_tokens: 5,
        cache_write_tokens: 6,
        output_tokens: 4,
        reasoning_output_tokens: 0,
      },
    ]);
    expect(claudeTurnModelUsage({ stopReason: "end_turn" })).toEqual([]);
    expect(claudeTurnModelUsage(undefined)).toEqual([]);
  });
});

describe("codexTurnModelUsage", () => {
  it("is the thread total's growth over the turn, first request included", () => {
    // Before the turn the thread had used 1000 input (400 cached) and 100
    // output; the turn's first request used 300 (100 cached) and 20.
    const first = {
      total: { inputTokens: 1300, cachedInputTokens: 500, outputTokens: 120 },
      last: { inputTokens: 300, cachedInputTokens: 100, outputTokens: 20 },
    };
    const latest = {
      total: {
        inputTokens: 2000,
        cachedInputTokens: 900,
        outputTokens: 300,
        reasoningOutputTokens: 80,
      },
    };
    expect(codexTurnModelUsage("gpt-6.1-sol", first, latest)).toEqual([
      {
        model: "gpt-6.1-sol",
        // 1000 input in the turn, 500 of it cached.
        input_tokens: 500,
        cached_input_tokens: 500,
        cache_write_tokens: 0,
        output_tokens: 200,
        reasoning_output_tokens: 80,
      },
    ]);
  });

  it("has nothing without reports", () => {
    expect(codexTurnModelUsage("m", undefined, undefined)).toEqual([]);
    expect(
      codexTurnModelUsage(
        "m",
        { total: { inputTokens: 5 }, last: { inputTokens: 5 } },
        { total: { inputTokens: 0 } },
      ),
    ).toEqual([]);
  });
});

describe("mergeTurnModelUsage", () => {
  it("sums the same model", () => {
    const entry = {
      model: "m",
      input_tokens: 1,
      cached_input_tokens: 2,
      cache_write_tokens: 3,
      output_tokens: 4,
      reasoning_output_tokens: 5,
    };
    expect(
      mergeTurnModelUsage([entry, entry, { ...entry, model: "n" }]),
    ).toEqual([
      {
        model: "m",
        input_tokens: 2,
        cached_input_tokens: 4,
        cache_write_tokens: 6,
        output_tokens: 8,
        reasoning_output_tokens: 10,
      },
      { ...entry, model: "n" },
    ]);
  });
});
