import {
  agentTurnStatusOf,
  agentTurnStatusText,
  parseAgentTurnStatus,
  sameAgentTurnStatus,
  withOwnTurnStatus,
} from "./agent-status";

const NOW = Date.parse("2026-10-20T06:00:00Z");
const limit = (resets_at?: number) => ({
  version: 1 as const,
  state: "failed" as const,
  failure: {
    kind: "limit" as const,
    scope: "credential" as const,
    credential_id: "11111111-1111-4111-8111-111111111111",
    ...(resets_at ? { resets_at } : {}),
  },
});

describe("an agent's turn status", () => {
  it("is unavailable until a usage limit resets, without naming the credential", () => {
    const status = agentTurnStatusOf({
      running: 0,
      queued: 2,
      last: { outcome: limit(NOW + 3_600_000), at: NOW - 1000 },
      now: NOW,
    });
    expect(status).toEqual({
      version: 1,
      running: 0,
      queued: 2,
      unavailable: { reason: "limit", until: NOW + 3_600_000 },
      last: { state: "failed", kind: "limit", at: NOW - 1000 },
      at: NOW,
    });
    expect(JSON.stringify(status)).not.toMatch(/credential/);
    expect(agentTurnStatusText(status, NOW)).toBe(
      "unavailable until 2026-10-20T07:00:00.000Z (usage limit)",
    );
  });

  it("is not unavailable once the limit reset, or while a turn runs", () => {
    expect(
      agentTurnStatusOf({
        running: 0,
        queued: 0,
        last: { outcome: limit(NOW - 1), at: NOW - 5000 },
        now: NOW,
      }).unavailable,
    ).toBeUndefined();
    expect(
      agentTurnStatusOf({
        running: 1,
        queued: 0,
        last: { outcome: limit(NOW + 1000), at: NOW - 5000 },
        now: NOW,
      }).unavailable,
    ).toBeUndefined();
  });

  it("needs its sign-in renewed after a sign-in failure", () => {
    const status = agentTurnStatusOf({
      running: 0,
      queued: 0,
      last: {
        outcome: {
          version: 1,
          state: "failed",
          failure: { kind: "sign-in" },
        },
        at: NOW,
      },
      now: NOW,
    });
    expect(status.unavailable).toEqual({ reason: "sign-in" });
    expect(agentTurnStatusText(status, NOW)).toBe(
      "unavailable (sign-in needs renewing)",
    );
  });

  it.each([
    [{ running: 1, queued: 0 }, "busy"],
    [{ running: 1, queued: 2 }, "busy, 2 waiting"],
    [{ running: 0, queued: 3 }, "3 waiting"],
    [{ running: 0, queued: 0 }, "idle"],
  ])("%j reads %s", (counts, text) => {
    expect(
      agentTurnStatusText(agentTurnStatusOf({ ...counts, now: NOW }), NOW),
    ).toBe(text);
  });

  it("says nothing once it is a day old", () => {
    const status = agentTurnStatusOf({ running: 1, queued: 0, now: NOW });
    expect(agentTurnStatusText(status, NOW + 25 * 60 * 60_000)).toBeUndefined();
  });

  it("parses only what it defines, and compares without the time", () => {
    const status = agentTurnStatusOf({ running: 0, queued: 1, now: NOW });
    expect(
      parseAgentTurnStatus({ ...status, extra: "credential name" }),
    ).toEqual(status);
    for (const bad of [
      null,
      { ...status, version: 2 },
      { ...status, running: -1 },
      { ...status, unavailable: { reason: "broke" } },
      { ...status, last: { state: "won", at: NOW } },
    ])
      expect(parseAgentTurnStatus(bad)).toBeUndefined();
    expect(sameAgentTurnStatus(status, { ...status, at: NOW + 10 })).toBe(true);
    expect(sameAgentTurnStatus(status, { ...status, queued: 2 })).toBe(false);
  });
});

describe("an identity as one account sees it", () => {
  const mine = "00000000-1000-4000-8000-000000000001";
  const theirs = "00000000-1000-4000-8000-000000000002";
  const identity = {
    agent_id: "a",
    name: "claude-1",
    turn_status: {
      version: 1,
      running: 0,
      queued: 0,
      by_account: {
        [mine]: { reason: "limit", until: NOW + 60_000 },
        [theirs]: { reason: "sign-in" },
      },
      at: NOW,
    },
  };

  it("carries only its own limit or sign-in, never another account's", () => {
    expect(withOwnTurnStatus(identity, mine)).toEqual({
      agent_id: "a",
      name: "claude-1",
      turn_status: {
        version: 1,
        running: 0,
        queued: 0,
        unavailable: { reason: "limit", until: NOW + 60_000 },
        at: NOW,
      },
    });
    const other = "00000000-1000-4000-8000-000000000003";
    expect(withOwnTurnStatus([identity], other)[0].turn_status).toEqual({
      version: 1,
      running: 0,
      queued: 0,
      at: NOW,
    });
    expect(
      JSON.stringify(withOwnTurnStatus([identity], undefined)),
    ).not.toMatch(theirs);
  });

  it("leaves everything else alone", () => {
    expect(withOwnTurnStatus(undefined, mine)).toBeUndefined();
    expect(withOwnTurnStatus({ token: "t" }, mine)).toEqual({ token: "t" });
    const none = { agent_id: "a", turn_status: null };
    expect(withOwnTurnStatus(none, mine)).toBe(none);
  });
});

describe("what a manager reads about a peer", () => {
  it("says since when it is busy and how its last turn ended, in one line", () => {
    const status = agentTurnStatusOf({
      running: 1,
      queued: 0,
      runningSince: NOW - 90_000,
      last: {
        outcome: {
          version: 1,
          state: "failed",
          failure: { kind: "error", code: "x" },
          detail: "This agent turn could not run:\n  the model\trefused.",
        },
        at: NOW - 600_000,
      },
      now: NOW,
    });
    expect(status.running_since).toBe(NOW - 90_000);
    expect(status.last).toEqual({
      state: "failed",
      kind: "error",
      detail: "This agent turn could not run: the model refused.",
      at: NOW - 600_000,
    });
    // Idle: no busy-since.
    expect(
      agentTurnStatusOf({
        running: 0,
        queued: 0,
        runningSince: NOW - 90_000,
        now: NOW,
      }).running_since,
    ).toBeUndefined();
  });

  it("parses the new fields bounded, and refuses wrong types", () => {
    const parsed = parseAgentTurnStatus({
      version: 1,
      running: 1,
      queued: 0,
      running_since: NOW - 1,
      last: { state: "completed", detail: "x".repeat(1000), at: NOW - 5 },
      at: NOW,
    });
    expect(parsed?.running_since).toBe(NOW - 1);
    expect(parsed?.last?.detail).toHaveLength(300);
    for (const bad of [
      { running_since: "soon" },
      { last: { state: "completed", detail: 5, at: NOW } },
    ])
      expect(
        parseAgentTurnStatus({
          version: 1,
          running: 0,
          queued: 0,
          at: NOW,
          ...bad,
        }),
      ).toBeUndefined();
  });
});
