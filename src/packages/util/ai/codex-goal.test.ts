import { normalizeCodexGoal, normalizeCodexGoalSnapshot } from "./codex-goal";

const goal = {
  objective: "Finish the work",
  status: "active",
  tokenBudget: 1000,
  tokensUsed: 750,
  timeUsedSeconds: 60,
  updatedAt: 100,
};

describe("Codex goal status normalization", () => {
  it.each([
    ["usageLimited", "usage_limited"],
    ["budgetLimited", "budget_limited"],
    ["usage_limited", "usage_limited"],
    ["budget_limited", "budget_limited"],
    ["active", "active"],
    ["paused", "paused"],
    ["blocked", "blocked"],
    ["complete", "complete"],
  ])("normalizes %s to %s", (wireStatus, status) => {
    expect(normalizeCodexGoal({ ...goal, status: wireStatus })).toEqual({
      ...goal,
      status,
    });
    expect(
      normalizeCodexGoalSnapshot({
        sessionId: "session",
        observedAt: 101,
        goal: { ...goal, status: wireStatus },
      }),
    ).toEqual({
      sessionId: "session",
      observedAt: 101,
      goal: { ...goal, status },
    });
  });

  it("normalizes Immutable-like stored values without changing their source", () => {
    const value = { ...goal, status: "usageLimited" };
    expect(normalizeCodexGoal({ toJS: () => value })?.status).toBe(
      "usage_limited",
    );
    expect(value.status).toBe("usageLimited");
  });

  it.each(["unknown", "UsageLimited", "", null, undefined, 1])(
    "rejects an unrecognized status: %s",
    (status) => {
      expect(normalizeCodexGoal({ ...goal, status })).toBeUndefined();
    },
  );
});
