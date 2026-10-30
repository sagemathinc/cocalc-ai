import {
  CLAUDE_POOL_RESERVATION_MS,
  DEFAULT_HEAVY_TURN_COST,
  DEFAULT_TURN_COST,
  appendTurnCostSamples,
  claudePoolForecast,
  claudePoolMemberFromMetadata,
  claudePoolWindows,
  claudeTurnCostEstimate,
  claudePoolReservedAmount,
  parseClaudePoolReservations,
  parseTurnCostSamples,
  pickClaudePoolCredential,
  type ClaudePoolMember,
} from "./claude-pool";

const now = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3600_000;
const sec = (ms: number) => Math.round(ms / 1000);

function member(
  id: string,
  {
    five = 0,
    fiveResetsIn = 2 * HOUR,
    week = 0,
    weekResetsIn = 72 * HOUR,
    observedAgo = 0,
    ...rest
  }: Partial<ClaudePoolMember> & {
    five?: number;
    fiveResetsIn?: number;
    week?: number;
    weekResetsIn?: number;
    observedAgo?: number;
  } = {},
): ClaudePoolMember {
  return {
    credential_id: id,
    usage: {
      observed_at: new Date(now - observedAgo).toISOString(),
      windows: {
        five_hour: { utilization: five, resets_at: sec(now + fiveResetsIn) },
        seven_day: { utilization: week, resets_at: sec(now + weekResetsIn) },
      },
    },
    ...rest,
  };
}

const cost = { typical: 0.02, heavy: 0.1, samples: 0 };

describe("turn cost estimate", () => {
  it("uses defaults until there are enough turns, raised to the largest seen", () => {
    expect(claudeTurnCostEstimate([])).toEqual({
      typical: DEFAULT_TURN_COST,
      heavy: DEFAULT_HEAVY_TURN_COST,
      samples: 0,
    });
    expect(claudeTurnCostEstimate([0.01, 0.3]).heavy).toBe(0.3);
  });

  it("is the mean and the 95th percentile of observed turns", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) / 100);
    const estimate = claudeTurnCostEstimate(samples);
    expect(estimate.typical).toBeCloseTo(0.105);
    expect(estimate.heavy).toBe(0.19);
    expect(estimate.samples).toBe(20);
  });

  it("keeps only valid, recent samples", () => {
    expect(parseTurnCostSamples({ samples: [0.1, -1, 2, "x", 0.2] })).toEqual([
      0.1, 0.2,
    ]);
    const many = appendTurnCostSamples({ samples: Array(50).fill(0.01) }, [
      0.5,
      NaN,
    ]);
    expect(many.samples).toHaveLength(50);
    expect(many.samples.at(-1)).toBe(0.5);
  });
});

describe("pool windows", () => {
  it("treats a window whose reset has passed as unused", () => {
    const stale = member("a", {
      five: 0.99,
      fiveResetsIn: -HOUR,
      week: 0.5,
      observedAgo: 3 * HOUR,
    });
    expect(claudePoolWindows(stale, now)).toMatchObject({ five: 0, week: 0.5 });
  });

  it("reads limits and the limited marker from credential metadata", () => {
    const m = claudePoolMemberFromMetadata(
      "a",
      {
        claude_usage: member("a", { five: 0.4 }).usage,
        claude_pool_limited: { until: new Date(now + HOUR).toISOString() },
      },
      now,
    );
    expect(m.limited_until).toBe(now + HOUR);
    expect(m.usage?.windows.five_hour?.utilization).toBe(0.4);
    expect(
      claudePoolMemberFromMetadata(
        "a",
        { claude_pool_limited: { until: new Date(now - 1).toISOString() } },
        now,
      ).limited_until,
    ).toBeUndefined();
  });
});

describe("pick", () => {
  it("prefers the weekly capacity that expires soonest", () => {
    const pick = pickClaudePoolCredential({
      members: [
        member("late", { week: 0.2, weekResetsIn: 120 * HOUR }),
        member("soon", { week: 0.2, weekResetsIn: 10 * HOUR }),
      ],
      cost,
      now,
    });
    expect(pick).toEqual({ credential_id: "soon" });
  });

  it("skips a subscription where a heavy turn would not fit in 5 hours", () => {
    const pick = pickClaudePoolCredential({
      members: [
        member("full", { five: 0.91, weekResetsIn: 10 * HOUR }),
        member("ok", { five: 0.5, weekResetsIn: 100 * HOUR }),
      ],
      cost,
      now,
    });
    expect(pick).toEqual({ credential_id: "ok" });
  });

  it("counts turns already running on a subscription", () => {
    const pick = pickClaudePoolCredential({
      members: [
        member("busy", { five: 0.8, weekResetsIn: 10 * HOUR, reserved: 0.15 }),
        member("idle", { five: 0.5, weekResetsIn: 100 * HOUR }),
      ],
      cost,
      now,
    });
    expect(pick).toEqual({ credential_id: "idle" });
  });

  it("skips a subscription whose week is used up, and one marked limited", () => {
    const pick = pickClaudePoolCredential({
      members: [
        member("week", { week: 0.99, weekResetsIn: 2 * HOUR }),
        member("limited", { limited_until: now + HOUR }),
        member("ok", { week: 0.9, weekResetsIn: 100 * HOUR }),
      ],
      cost,
      now,
    });
    expect(pick).toEqual({ credential_id: "ok" });
  });

  it("keeps the current subscription unless another is much better", () => {
    const members = [
      member("a", { week: 0.5, weekResetsIn: 50 * HOUR }),
      member("b", { week: 0.5, weekResetsIn: 40 * HOUR }),
    ];
    expect(
      pickClaudePoolCredential({ members, cost, current: "a", now }),
    ).toEqual({ credential_id: "a" });
    expect(
      pickClaudePoolCredential({
        members: [
          members[0],
          member("b", { week: 0.5, weekResetsIn: 20 * HOUR }),
        ],
        cost,
        current: "a",
        now,
      }),
    ).toEqual({ credential_id: "b" });
  });

  it("holds until the earliest time one can take a turn", () => {
    expect(
      pickClaudePoolCredential({
        members: [
          member("a", { five: 1, fiveResetsIn: 3 * HOUR }),
          member("b", { five: 0.95, fiveResetsIn: 2 * HOUR }),
          member("c", { limited_until: now + 4 * HOUR }),
        ],
        cost,
        now,
      }),
    ).toEqual({ hold_until: now + 2 * HOUR, next_credential_id: "b" });
    expect(
      pickClaudePoolCredential({
        members: [member("a", { five: 0.85, reserved: 0.1 })],
        cost,
        now,
      }),
    ).toEqual({
      hold_until: now + CLAUDE_POOL_RESERVATION_MS,
      next_credential_id: "a",
    });
    expect(pickClaudePoolCredential({ members: [], cost, now })).toEqual({});
  });

  it("uses a subscription never reported as unused", () => {
    expect(
      pickClaudePoolCredential({
        members: [member("used", { five: 0.95 }), { credential_id: "new" }],
        cost,
        now,
      }),
    ).toEqual({ credential_id: "new" });
  });
});

describe("forecast", () => {
  it("sums what is left of each week", () => {
    const forecast = claudePoolForecast(
      [member("a", { week: 0.25 }), { credential_id: "b" }],
      now,
    );
    expect(forecast.members).toBe(2);
    expect(forecast.remaining).toBeCloseTo(1.75);
  });

  it("runs out when every week is used before it resets", () => {
    // Each used half its week in the first 12 hours of a week: 1/24 per hour
    // each, 1/12 for the pool; 1 left, so about 12 hours.
    const forecast = claudePoolForecast(
      [
        member("a", { week: 0.5, weekResetsIn: 156 * HOUR }),
        member("b", { week: 0.5, weekResetsIn: 156 * HOUR }),
      ],
      now,
    );
    expect(forecast.ratePerHour).toBeCloseTo(1 / 12);
    expect(forecast.runsOutAt).toBe(now + 12 * HOUR);
  });

  it("does not run out when resets come first", () => {
    const forecast = claudePoolForecast(
      [
        member("a", { week: 0.1, weekResetsIn: 12 * HOUR }),
        member("b", { week: 0.1, weekResetsIn: 100 * HOUR }),
      ],
      now,
    );
    expect(forecast.ratePerHour).toBeGreaterThan(0);
    expect(forecast.runsOutAt).toBeUndefined();
  });
});

describe("reservations", () => {
  it("keeps only valid ones still in effect", () => {
    const r = parseClaudePoolReservations(
      {
        aa: { amount: 0.02, expires: now + 60_000 },
        bb: { amount: 0.02, expires: now - 1 },
        cc: { amount: 7, expires: now + 60_000 },
        "not-hex": { amount: 0.02, expires: now + 60_000 },
        dd: { amount: 0.03, expires: now + 48 * HOUR },
      },
      now,
    );
    expect(Object.keys(r)).toEqual(["aa"]);
    expect(claudePoolReservedAmount(r)).toBeCloseTo(0.02);
    expect(parseClaudePoolReservations([1, 2], now)).toEqual({});
  });
});
