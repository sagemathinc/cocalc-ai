import { codexRateLimitSnapshot, mergeCodexUsage } from "./codex-usage";

const now = Date.parse("2026-11-05T12:00:00Z");
const s = (ms: number) => Math.floor(ms / 1000);
const HOUR = 3600_000;

const limits = {
  limitId: "codex",
  primary: {
    usedPercent: 42,
    windowDurationMins: 300,
    resetsAt: s(now + 2 * HOUR),
  },
  secondary: {
    usedPercent: 63.5,
    windowDurationMins: 10080,
    resetsAt: s(now + 72 * HOUR),
  },
  planType: "pro",
  credits: { balance: "secret-ish" },
};

describe("codexRateLimitSnapshot", () => {
  it("maps the 5-hour and weekly windows, keeping only their numbers", () => {
    const expected = {
      observed_at: new Date(now).toISOString(),
      windows: {
        five_hour: { utilization: 0.42, resets_at: s(now + 2 * HOUR) },
        seven_day: { utilization: 0.635, resets_at: s(now + 72 * HOUR) },
      },
    };
    // A snapshot, the update notification, and a read response by limit.
    expect(codexRateLimitSnapshot(limits, now)).toEqual(expected);
    expect(codexRateLimitSnapshot({ rateLimits: limits }, now)).toEqual(
      expected,
    );
    expect(
      codexRateLimitSnapshot(
        { rateLimits: limits, rateLimitsByLimitId: { codex: limits } },
        now,
      ),
    ).toEqual(expected);
    expect(JSON.stringify(codexRateLimitSnapshot(limits, now))).not.toMatch(
      /secret|pro|codex/,
    );
  });

  it("uses the stated window lengths, and skips windows of other lengths", () => {
    expect(
      codexRateLimitSnapshot(
        {
          primary: { ...limits.secondary },
          secondary: {
            usedPercent: 5,
            windowDurationMins: 60,
            resetsAt: s(now + HOUR),
          },
        },
        now,
      )?.windows,
    ).toEqual({
      seven_day: { utilization: 0.635, resets_at: s(now + 72 * HOUR) },
    });
    // Without lengths: primary is the 5-hour window.
    expect(
      codexRateLimitSnapshot(
        { primary: { usedPercent: 10, resetsAt: s(now + HOUR) } },
        now,
      )?.windows,
    ).toEqual({ five_hour: { utilization: 0.1, resets_at: s(now + HOUR) } });
  });

  it("rejects what has no usable window", () => {
    for (const value of [
      undefined,
      null,
      "x",
      {},
      { primary: null, secondary: null },
      { primary: { usedPercent: "42", resetsAt: s(now) } },
      { primary: { usedPercent: 42, resetsAt: null } },
      // A reset years away is not a real reading.
      { primary: { usedPercent: 42, resetsAt: s(now) * 10 } },
    ])
      expect(codexRateLimitSnapshot(value, now)).toBeUndefined();
  });
});

describe("mergeCodexUsage", () => {
  const full = codexRateLimitSnapshot(limits, now - HOUR)!;

  it("keeps a window a rolling update lacks until it resets", () => {
    const onlyFive = codexRateLimitSnapshot(
      { primary: { ...limits.primary, usedPercent: 50 } },
      now,
    )!;
    expect(mergeCodexUsage(full, onlyFive, now)).toEqual({
      observed_at: new Date(now).toISOString(),
      windows: {
        five_hour: { utilization: 0.5, resets_at: s(now + 2 * HOUR) },
        seven_day: full.windows.seven_day,
      },
    });
    // After the stored week reset, it is unknown rather than carried over.
    const later = now + 80 * HOUR;
    const update = codexRateLimitSnapshot(
      {
        primary: {
          usedPercent: 1,
          windowDurationMins: 300,
          resetsAt: s(later + HOUR),
        },
      },
      later,
    )!;
    expect(mergeCodexUsage(full, update, later).windows.seven_day).toBe(
      undefined,
    );
    // Nothing stored, or garbage: the update alone.
    expect(mergeCodexUsage({ junk: 1 }, onlyFive, now)).toEqual(onlyFive);
  });
});
