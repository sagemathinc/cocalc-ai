import {
  CLAUDE_USAGE_PROBE_METADATA_KEY,
  claudeAccountUsesAuto,
  claudeUsageProbeDue,
  parseClaudeUsageProbe,
} from "./claude-usage-probe";

const now = Date.parse("2026-11-19T20:00:00Z");
const HOUR = 3600_000;
const sec = (ms: number) => Math.round(ms / 1000);

function reading(ageMs: number, five = 0.3) {
  return {
    observed_at: new Date(now - ageMs).toISOString(),
    windows: {
      five_hour: { utilization: five, resets_at: sec(now + 2 * HOUR) },
      seven_day: { utilization: 0.5, resets_at: sec(now + 72 * HOUR) },
    },
  };
}

describe("claudeUsageProbeDue", () => {
  test("a reading over four hours old is due; a newer one is not", () => {
    expect(claudeUsageProbeDue({ claude_usage: reading(5 * HOUR) }, now)).toBe(
      true,
    );
    expect(claudeUsageProbeDue({ claude_usage: reading(3 * HOUR) }, now)).toBe(
      false,
    );
  });

  test("a subscription with no reading yet is due", () => {
    expect(claudeUsageProbeDue({}, now)).toBe(true);
    expect(claudeUsageProbeDue(undefined, now)).toBe(true);
  });

  test("not when taken out of the pool, or limited until later", () => {
    const stale = { claude_usage: reading(10 * HOUR) };
    expect(
      claudeUsageProbeDue({ ...stale, claude_pool_excluded: true }, now),
    ).toBe(false);
    expect(
      claudeUsageProbeDue(
        {
          ...stale,
          claude_pool_limited: {
            until: new Date(now + HOUR).toISOString(),
          },
        },
        now,
      ),
    ).toBe(false);
    expect(
      claudeUsageProbeDue(
        {
          ...stale,
          claude_pool_limited: {
            until: new Date(now - HOUR).toISOString(),
          },
        },
        now,
      ),
    ).toBe(true);
  });

  test("not within four hours of the last check, whatever its outcome", () => {
    const stale = { claude_usage: reading(10 * HOUR) };
    for (const probe of [
      { at: new Date(now - HOUR).toISOString() },
      { at: new Date(now - HOUR).toISOString(), ok: false, error: "x" },
    ])
      expect(
        claudeUsageProbeDue(
          { ...stale, [CLAUDE_USAGE_PROBE_METADATA_KEY]: probe },
          now,
        ),
      ).toBe(false);
    expect(
      claudeUsageProbeDue(
        {
          ...stale,
          [CLAUDE_USAGE_PROBE_METADATA_KEY]: {
            at: new Date(now - 5 * HOUR).toISOString(),
            ok: true,
          },
        },
        now,
      ),
    ).toBe(true);
  });

  test("not while its 5-hour window was full and has not reset", () => {
    expect(
      claudeUsageProbeDue({ claude_usage: reading(5 * HOUR, 1) }, now),
    ).toBe(false);
    const reset = reading(6 * HOUR, 1);
    reset.windows.five_hour.resets_at = sec(now - HOUR);
    expect(claudeUsageProbeDue({ claude_usage: reset }, now)).toBe(true);
  });
});

test("an account uses Auto when a pick recorded a reading this week", () => {
  const entry = (ageMs: number) => ({
    at: now - ageMs,
    week: 0.4,
    resets_at: sec(now + HOUR),
  });
  expect(
    claudeAccountUsesAuto(
      [
        { metadata: {} },
        {
          metadata: {
            claude_usage_history: [entry(9 * 24 * HOUR), entry(2 * 24 * HOUR)],
          },
        },
      ],
      now,
    ),
  ).toBe(true);
  expect(
    claudeAccountUsesAuto(
      [{ metadata: { claude_usage_history: [entry(8 * 24 * HOUR)] } }],
      now,
    ),
  ).toBe(false);
  expect(claudeAccountUsesAuto([{ metadata: null }, {}], now)).toBe(false);
});

test("stored checks are revalidated", () => {
  expect(
    parseClaudeUsageProbe({ at: "2026-11-19T20:00:00.000Z", ok: true }),
  ).toEqual({
    at: "2026-11-19T20:00:00.000Z",
    ok: true,
  });
  expect(parseClaudeUsageProbe({ at: "nope" })).toBeUndefined();
  expect(parseClaudeUsageProbe("x")).toBeUndefined();
  expect(
    parseClaudeUsageProbe({
      at: "2026-11-19T20:00:00Z",
      error: "e".repeat(999),
    })?.error,
  ).toHaveLength(300);
});
