import {
  claudeRateLimitSnapshot,
  claudeUsageProjection,
  claudeSubscriptionUsage,
  parseClaudeRateLimitSnapshot,
} from "./claude-usage";

const now = Date.parse("2026-10-02T12:00:00Z");
const hour = 3600;
const t = now / 1000;

describe("Claude subscription usage from rate limit reports", () => {
  it("keeps both windows from unifiedWindows as whitelisted numbers", () => {
    const snapshot = claudeRateLimitSnapshot(
      {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.31,
        unifiedWindows: {
          five_hour: { utilization: 0.02, resetsAt: t + hour, secret: "x" },
          seven_day: { utilization: 0.31, resetsAt: t + 40 * hour },
        },
        overageDisabledReason: "org_level_disabled",
      },
      now,
    );
    expect(snapshot).toEqual({
      observed_at: "2026-10-02T12:00:00.000Z",
      windows: {
        five_hour: { utilization: 0.02, resets_at: t + hour },
        seven_day: { utilization: 0.31, resets_at: t + 40 * hour },
      },
    });
  });

  it("falls back to the single limiter the report names", () => {
    expect(
      claudeRateLimitSnapshot(
        { rateLimitType: "five_hour", utilization: 0.5, resetsAt: t + hour },
        now,
      )?.windows,
    ).toEqual({ five_hour: { utilization: 0.5, resets_at: t + hour } });
  });

  it("ignores reports without usable windows", () => {
    for (const info of [
      undefined,
      "text",
      { status: "allowed" },
      { rateLimitType: "overage", utilization: 0.5, resetsAt: t + hour },
      { unifiedWindows: { five_hour: { utilization: -1, resetsAt: t } } },
      { unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 0 } } },
    ])
      expect(claudeRateLimitSnapshot(info, now)).toBeUndefined();
  });

  it("revalidates a stored snapshot and drops anything else", () => {
    expect(
      parseClaudeRateLimitSnapshot(
        {
          observed_at: "2026-10-02T11:00:00Z",
          windows: {
            five_hour: { utilization: 0.4, resets_at: t + hour },
            seven_day: { utilization: "0.4", resets_at: t + hour },
          },
          extra: "private",
        },
        now,
      ),
    ).toEqual({
      observed_at: "2026-10-02T11:00:00.000Z",
      windows: { five_hour: { utilization: 0.4, resets_at: t + hour } },
    });
    expect(
      parseClaudeRateLimitSnapshot(
        {
          observed_at: "2027-01-01T00:00:00Z",
          windows: { five_hour: { utilization: 0.4, resets_at: t + hour } },
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("shows percentages and marks windows that reset since the report", () => {
    expect(
      claudeSubscriptionUsage(
        {
          observed_at: "2026-10-02T06:00:00Z",
          windows: {
            five_hour: { utilization: 0.876, resets_at: t - hour },
            seven_day: { utilization: 0.31, resets_at: t + 40 * hour },
          },
        },
        now,
      ),
    ).toEqual({
      observedAt: "2026-10-02T06:00:00.000Z",
      windows: [
        {
          name: "Current session (5 hours)",
          usedPercent: 88,
          resetsAt: "2026-10-02T11:00:00.000Z",
          resetSinceObserved: true,
        },
        {
          name: "This week",
          usedPercent: 31,
          resetsAt: "2026-10-04T04:00:00.000Z",
        },
      ],
    });
  });
});

describe("claudeUsageProjection", () => {
  const H = 3600_000;
  const observed = Date.UTC(2026, 9, 16, 12);
  test("60% of the week used with 3 days left reaches the limit early", () => {
    // William's screenshot, 2026-10-16: 4 of 7 days elapsed, 15% a day.
    const projection = claudeUsageProjection({
      utilization: 0.6,
      resetsAtMs: observed + 3 * 24 * H,
      observedAtMs: observed,
      lengthMs: 7 * 24 * H,
    })!;
    expect(projection.percentAtReset).toBe(105);
    // 100% after 6.67 days, about 8 hours before the reset.
    expect(Date.parse(projection.limitAt)).toBeCloseTo(
      observed - 4 * 24 * H + (4 * 24 * H) / 0.6,
      -3,
    );
  });
  test("no warning when on track to stay under the limit", () => {
    expect(
      claudeUsageProjection({
        utilization: 0.13,
        resetsAtMs: observed + 2.5 * H,
        observedAtMs: observed,
        lengthMs: 5 * H,
      }),
    ).toBeUndefined();
  });
  test("no projection too early in a window or without usage", () => {
    // 13% half an hour into a 5-hour session would project 130%: too noisy.
    expect(
      claudeUsageProjection({
        utilization: 0.13,
        resetsAtMs: observed + 4.5 * H,
        observedAtMs: observed,
        lengthMs: 5 * H,
      }),
    ).toBeUndefined();
    expect(
      claudeUsageProjection({
        utilization: 0,
        resetsAtMs: observed + H,
        observedAtMs: observed,
        lengthMs: 5 * H,
      }),
    ).toBeUndefined();
  });
  test("claudeSubscriptionUsage attaches the projection to its window", () => {
    const t = observed / 1000;
    const usage = claudeSubscriptionUsage(
      {
        observed_at: new Date(observed).toISOString(),
        windows: {
          five_hour: { utilization: 0.13, resets_at: t + 2.5 * 3600 },
          seven_day: { utilization: 0.6, resets_at: t + 3 * 24 * 3600 },
        },
      },
      observed,
    )!;
    expect(usage.windows[0].projection).toBeUndefined();
    expect(usage.windows[1].projection?.percentAtReset).toBe(105);
  });
});
