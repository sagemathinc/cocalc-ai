import {
  CLAUDE_USAGE_HISTORY_METADATA_KEY,
  CLAUDE_POOL_EXCLUDED_METADATA_KEY,
  CLAUDE_POOL_LIMITED_METADATA_KEY,
  CLAUDE_POOL_RESERVATIONS_METADATA_KEY,
} from "./claude-pool";
import { CLAUDE_USAGE_METADATA_KEY } from "./claude-usage";
import { aiSubscriptionStatus } from "./subscription-status";

const now = Date.parse("2026-11-05T12:00:00Z");
const s = (ms: number) => Math.floor(ms / 1000);
const HOUR = 3600_000;

const usage = (five: number, week: number, observed = now - HOUR) => ({
  observed_at: new Date(observed).toISOString(),
  windows: {
    five_hour: { utilization: five, resets_at: s(now + 2 * HOUR) },
    seven_day: { utilization: week, resets_at: s(now + 72 * HOUR) },
  },
});

const claude = (id: string, metadata: Record<string, unknown>) => ({
  id,
  provider: "anthropic",
  kind: "claude-subscription-home-v1",
  scope: "account",
  metadata,
  last_used: new Date(now - HOUR),
});

describe("aiSubscriptionStatus", () => {
  it("reports each subscription and the pool, and nothing secret", () => {
    const status = aiSubscriptionStatus(
      [
        claude("a", {
          label: "Ultra 1",
          [CLAUDE_USAGE_METADATA_KEY]: usage(0.2, 0.5),
          [CLAUDE_POOL_RESERVATIONS_METADATA_KEY]: {
            abc: { amount: 0.02, expires: now + 60_000 },
          },
          secret: "sk-should-not-appear",
        }),
        claude("b", {
          label: "Ultra 2",
          [CLAUDE_USAGE_METADATA_KEY]: usage(0.95, 0.4),
        }),
        claude("c", {
          label: "Personal",
          [CLAUDE_POOL_EXCLUDED_METADATA_KEY]: true,
          [CLAUDE_POOL_LIMITED_METADATA_KEY]: {
            until: new Date(now + HOUR).toISOString(),
          },
        }),
        { ...claude("d", { label: "Revoked" }), revoked: new Date(now) },
        {
          id: "x",
          provider: "openai",
          kind: "codex-subscription-auth-json",
          scope: "account",
          metadata: {
            label: "Work",
            email: "w@example.com",
            plan_type: "pro",
            cocalc_default: true,
            provider_account_id: "acct-secretish",
          },
        },
        {
          id: "k",
          provider: "openai",
          kind: "openai-api-key",
          metadata: { label: "key" },
        },
      ],
      now,
    );
    expect(JSON.stringify(status)).not.toMatch(/sk-should|acct-secretish/);

    const [a, b, c] = status.claude.subscriptions;
    expect(status.claude.subscriptions.map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(a).toMatchObject({
      label: "Ultra 1",
      in_auto: true,
      five_hour: { used_percent: 20 },
      week: { used_percent: 50 },
      running_turns: 1,
      available_now: true,
      last_used: new Date(now - HOUR).toISOString(),
    });
    expect(a.five_hour?.resets_at).toBe(
      new Date(s(now + 2 * HOUR) * 1000).toISOString(),
    );
    // A large turn does not fit its 5-hour window until it resets.
    expect(b.available_now).toBe(false);
    expect(b.available_at).toBe(b.five_hour?.resets_at);
    expect(c).toMatchObject({
      in_auto: false,
      available_now: false,
      limited_until: new Date(now + HOUR).toISOString(),
    });
    expect(c.five_hour).toBeUndefined();

    // Only a and b are in Auto; c is excluded.
    expect(status.claude.auto).toMatchObject({
      members: 2,
      available_now: 1,
      weekly_limits_left: 1.1,
    });
    expect(status.claude.auto.next_available_at).toBeUndefined();

    expect(status.codex.subscriptions).toEqual([
      {
        id: "x",
        label: "Work",
        email: "w@example.com",
        plan_type: "pro",
        default: true,
      },
    ]);
  });

  it("uses only the account's own subscriptions, as Auto selects them", () => {
    const decoy = (over: Record<string, string>) => ({
      ...claude("decoy", {
        label: "decoy",
        [CLAUDE_USAGE_METADATA_KEY]: usage(0.99, 0.99),
      }),
      ...over,
    });
    const status = aiSubscriptionStatus(
      [
        claude("a", { [CLAUDE_USAGE_METADATA_KEY]: usage(0.2, 0.5) }),
        decoy({ provider: "openai" }),
        decoy({ scope: "project" }),
        decoy({ kind: "anthropic-api-key" }),
        {
          id: "codex-decoy",
          provider: "anthropic",
          kind: "codex-subscription-auth-json",
          scope: "account",
          metadata: { label: "decoy" },
        },
        {
          id: "codex-project",
          provider: "openai",
          kind: "codex-subscription-auth-json",
          scope: "project",
          metadata: { label: "decoy" },
        },
      ],
      now,
    );
    expect(JSON.stringify(status)).not.toMatch(/decoy/);
    expect(status.claude.subscriptions.map((x) => x.id)).toEqual(["a"]);
    expect(status.claude.auto.members).toBe(1);
    expect(status.claude.auto.weekly_limits_left).toBe(0.5);
    expect(status.codex.subscriptions).toEqual([]);
  });

  it("reports how fast each subscription's week is being used", () => {
    const resets = s(now + 72 * HOUR);
    // 1% every 30 minutes for the last 15 hours: 48% a day.
    const history = Array.from({ length: 31 }, (_, i) => ({
      at: now - (30 - i) * 30 * 60_000,
      week: 0.2 + i * 0.01,
      resets_at: resets,
    }));
    const current = usage(0.1, 0.5, now);
    current.windows.seven_day.resets_at = resets;
    const [a, b] = aiSubscriptionStatus(
      [
        claude("a", {
          [CLAUDE_USAGE_METADATA_KEY]: current,
          [CLAUDE_USAGE_HISTORY_METADATA_KEY]: history,
        }),
        claude("b", { [CLAUDE_USAGE_METADATA_KEY]: usage(0.1, 0.5) }),
      ],
      now,
    ).claude.subscriptions;
    expect(a.week_percent_per_day).toBeCloseTo(48, 0);
    expect(a.week_history!.length).toBeLessThanOrEqual(12);
    // Oldest first, ending with the newest reading.
    expect(a.week_history!.at(-1)).toEqual({
      at: new Date(now).toISOString(),
      used_percent: 50,
      resets_at: new Date(resets * 1000).toISOString(),
    });
    const times = a.week_history!.map((r) => Date.parse(r.at));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    // Without readings over time, no rate is claimed.
    expect(b.week_percent_per_day).toBeUndefined();
    expect(b.week_history).toBeUndefined();
  });

  it("skips stored readings with unrepresentable or future times", () => {
    const resets = s(now + 72 * HOUR);
    const good = [
      { at: now - 4 * HOUR, week: 0.2, resets_at: resets },
      { at: now - 2 * HOUR, week: 0.3, resets_at: resets },
    ];
    const current = usage(0.1, 0.4, now - HOUR);
    current.windows.seven_day.resets_at = resets;
    const [a] = aiSubscriptionStatus(
      [
        claude("a", {
          [CLAUDE_USAGE_METADATA_KEY]: current,
          [CLAUDE_USAGE_HISTORY_METADATA_KEY]: [
            { at: 1e20, week: 0.5, resets_at: resets },
            good[0],
            { at: now - 3 * HOUR, week: 0.25, resets_at: 1e20 },
            good[1],
            { at: now + HOUR, week: 0.9, resets_at: resets },
          ],
        }),
      ],
      now,
    ).claude.subscriptions;
    expect(a.week_history!.map((r) => r.used_percent)).toEqual([20, 30]);
    for (const r of a.week_history!) {
      expect(typeof r.at).toBe("string");
      expect(typeof r.resets_at).toBe("string");
    }
    expect(a.week_percent_per_day).toBeGreaterThan(0);
  });

  it("reports Codex usage as Codex last reported it, with its weekly rate", () => {
    const resets = s(now + 72 * HOUR);
    const history = Array.from({ length: 7 }, (_, i) => ({
      at: now - (6 - i) * HOUR,
      week: 0.3 + i * 0.01,
      resets_at: resets,
    }));
    const [codex] = aiSubscriptionStatus(
      [
        {
          id: "x",
          provider: "openai",
          kind: "codex-subscription-auth-json",
          scope: "account",
          metadata: {
            label: "Work",
            codex_usage: {
              observed_at: new Date(now - HOUR).toISOString(),
              windows: {
                five_hour: { utilization: 0.4, resets_at: s(now + 2 * HOUR) },
                seven_day: { utilization: 0.36, resets_at: resets },
              },
            },
            codex_usage_history: history,
          },
        },
      ],
      now,
    ).codex.subscriptions;
    expect(codex).toMatchObject({
      id: "x",
      label: "Work",
      observed_at: new Date(now - HOUR).toISOString(),
      five_hour: { used_percent: 40 },
      week: { used_percent: 36 },
    });
    // 1% an hour: 24% a day.
    expect(codex.week_percent_per_day).toBeCloseTo(24, 0);
    expect(codex.week_history).toHaveLength(7);
  });

  it("says when the pool has room again", () => {
    const status = aiSubscriptionStatus(
      [claude("a", { [CLAUDE_USAGE_METADATA_KEY]: usage(0.99, 0.2) })],
      now,
    );
    expect(status.claude.auto.available_now).toBe(0);
    expect(status.claude.auto.next_available_at).toBe(
      new Date(s(now + 2 * HOUR) * 1000).toISOString(),
    );
  });

  it("treats a window whose reset passed as unused", () => {
    const old = usage(0.9, 0.9, now - 200 * HOUR);
    old.windows.five_hour.resets_at = s(now - HOUR);
    old.windows.seven_day.resets_at = s(now - HOUR);
    const [a] = aiSubscriptionStatus(
      [claude("a", { [CLAUDE_USAGE_METADATA_KEY]: old })],
      now,
    ).claude.subscriptions;
    expect(a.five_hour).toEqual({ used_percent: 0 });
    expect(a.week).toEqual({ used_percent: 0 });
    expect(a.available_now).toBe(true);
  });

  it("is empty without subscriptions", () => {
    const status = aiSubscriptionStatus([], now);
    expect(status.claude.subscriptions).toEqual([]);
    expect(status.claude.auto.members).toBe(0);
    expect(status.codex.subscriptions).toEqual([]);
  });
});
