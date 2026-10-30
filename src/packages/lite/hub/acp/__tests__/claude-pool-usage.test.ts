import {
  beginClaudePoolTurnUsage,
  endClaudePoolTurnUsage,
  measuredTurns,
  noteClaudePoolRateLimit,
  pendingTurnCostAccounts,
  resetClaudePoolUsage,
  restoreTurnCosts,
  takeTurnCosts,
} from "../claude-pool-usage";

const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const account_id = "11111111-1111-4111-8111-111111111111";
const project_id = "22222222-2222-4222-8222-222222222222";
const conversation = { projectId: project_id, path: "a.chat", threadId: "t" };
const resetsAt = Math.round(Date.now() / 1000) + 3600;

function request(credentialId: string, pool = true) {
  return {
    project_id,
    account_id,
    prompt: "",
    ...(pool ? { harness_pool: {} } : {}),
    harness_credential: {
      version: 1,
      provider: "anthropic",
      mode: "account-subscription",
      credentialId,
    },
    chat: { project_id, path: "a.chat", thread_id: "t" },
  } as any;
}

const report = (utilization: number, resets = resetsAt) => ({
  unifiedWindows: { five_hour: { utilization, resetsAt: resets } },
});

afterEach(() => resetClaudePoolUsage());

describe("per-turn usage of an Auto turn", () => {
  it("is the 5-hour change between its first and last report", () => {
    beginClaudePoolTurnUsage(request(A));
    noteClaudePoolRateLimit(conversation, A, report(0.1));
    noteClaudePoolRateLimit(conversation, A, report(0.12));
    noteClaudePoolRateLimit(conversation, A, report(0.14));
    endClaudePoolTurnUsage(request(A));
    const costs = takeTurnCosts(account_id)!;
    expect(costs).toHaveLength(1);
    expect(costs[0].credential_id).toBe(A);
    expect(costs[0].cost).toBeCloseTo(0.04);
    expect(takeTurnCosts(account_id)).toBeUndefined();
  });

  it("restarts at a new 5-hour window, and ignores other subscriptions", () => {
    beginClaudePoolTurnUsage(request(A));
    noteClaudePoolRateLimit(conversation, A, report(0.9));
    noteClaudePoolRateLimit(conversation, A, report(0.01, resetsAt + 5 * 3600));
    noteClaudePoolRateLimit(conversation, A, report(0.03, resetsAt + 5 * 3600));
    noteClaudePoolRateLimit(conversation, B, report(0.5));
    endClaudePoolTurnUsage(request(A));
    expect(takeTurnCosts(account_id)![0].cost).toBeCloseTo(0.02);
  });

  it("measures only Auto turns with a report", () => {
    beginClaudePoolTurnUsage(request(A, false));
    noteClaudePoolRateLimit(conversation, A, report(0.1));
    endClaudePoolTurnUsage(request(A, false));
    beginClaudePoolTurnUsage(request(A));
    endClaudePoolTurnUsage(request(A));
    expect(takeTurnCosts(account_id)).toBeUndefined();
  });

  it("keeps observations a failed pick could not send", () => {
    restoreTurnCosts(account_id, [{ credential_id: A, cost: 0.01 }]);
    expect(takeTurnCosts(account_id)).toEqual([
      { credential_id: A, cost: 0.01 },
    ]);
  });
});

describe("bounded on a long-lived host", () => {
  const now = Date.now();
  it("drops an account's observations after an hour, with no later call from it", () => {
    restoreTurnCosts(account_id, [{ credential_id: A, cost: 0.01 }], now);
    expect(pendingTurnCostAccounts(now + 59 * 60_000)).toBe(1);
    expect(pendingTurnCostAccounts(now + 61 * 60_000)).toBe(0);
  });

  it("keeps at most 1000 accounts, dropping the oldest", () => {
    for (let i = 0; i < 1_005; i++)
      restoreTurnCosts(
        `account-${i}`,
        [{ credential_id: A, cost: 0.01 }],
        now + i,
      );
    expect(pendingTurnCostAccounts(now + 2_000)).toBe(1_000);
    expect(takeTurnCosts("account-0", now + 2_000)).toBeUndefined();
    expect(takeTurnCosts("account-1004", now + 2_000)).toHaveLength(1);
  });

  it("drops a turn that never ended once a day has passed", () => {
    beginClaudePoolTurnUsage(request(A), now);
    expect(measuredTurns()).toBe(1);
    beginClaudePoolTurnUsage(
      { ...request(A), chat: { project_id, path: "b.chat", thread_id: "u" } },
      now + 25 * 3600_000,
    );
    expect(measuredTurns()).toBe(1);
  });
});
