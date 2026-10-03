import {
  claudeRateLimitSnapshot,
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
