import { pickClaudePool, setClaudePoolStoreForTests } from "./claude-pool";

const account_id = "11111111-1111-4111-8111-111111111111";
const project_id = "22222222-2222-4222-8222-222222222222";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = Date.parse("2026-10-02T12:00:00Z");
const HOUR = 3600_000;
const sec = (ms: number) => Math.round(ms / 1000);

function usage(five: number, week: number, weekResetsIn: number) {
  return {
    observed_at: new Date(now).toISOString(),
    windows: {
      five_hour: { utilization: five, resets_at: sec(now + 2 * HOUR) },
      seven_day: { utilization: week, resets_at: sec(now + weekResetsIn) },
    },
  };
}

function setup(rows: { id: string; metadata: Record<string, any> }[]) {
  const writes: { id: string; key: string; value: any }[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  setClaudePoolStoreForTests({
    locked: (owner, fn) => {
      expect(owner).toBe(account_id);
      const run = chain.then(async () => {
        const { result, updates } = await fn(
          rows.map((row) => ({ ...row, metadata: { ...row.metadata } })),
        );
        for (const { id, key, value } of updates) {
          writes.push({ id, key, value });
          const row = rows.find((r) => r.id === id)!;
          row.metadata = { ...row.metadata, [key]: value };
        }
        return result;
      });
      chain = run.catch(() => undefined);
      return run;
    },
  });
  return writes;
}

const without = (writes: { key: string }[], key: string) =>
  writes.filter((w) => w.key !== key);

const target = (thread_id: string) => ({ project_id, thread_id });

afterEach(() => setClaudePoolStoreForTests());

describe("pickClaudePool", () => {
  it("picks the subscription whose week expires soonest, with labels", async () => {
    setup([
      {
        id: A,
        metadata: { label: "max-a", claude_usage: usage(0, 0.2, 100 * HOUR) },
      },
      {
        id: B,
        metadata: { label: "max-b", claude_usage: usage(0, 0.2, 10 * HOUR) },
      },
    ]);
    expect(
      await pickClaudePool(
        { account_id, target: target("t1"), current_credential_id: A },
        () => now,
      ),
    ).toEqual({ credential_id: B, label: "max-b", current_label: "max-a" });
  });

  it("leaves out excluded subscriptions, and reports an empty pool", async () => {
    setup([
      { id: A, metadata: { claude_pool_excluded: true } },
      { id: B, metadata: { claude_usage: usage(0.5, 0.5, 100 * HOUR) } },
    ]);
    expect(
      await pickClaudePool({ account_id, target: target("t1") }, () => now),
    ).toEqual({ credential_id: B });
    setup([{ id: A, metadata: { claude_pool_excluded: true } }]);
    expect(
      await pickClaudePool({ account_id, target: target("t1") }, () => now),
    ).toEqual({ empty: true });
  });

  it("marks a subscription that hit its limit and moves off it", async () => {
    const writes = setup([
      { id: A, metadata: { claude_usage: usage(0.3, 0.1, 10 * HOUR) } },
      { id: B, metadata: { claude_usage: usage(0.3, 0.1, 100 * HOUR) } },
    ]);
    const result = await pickClaudePool(
      {
        account_id,
        target: target("t1"),
        current_credential_id: A,
        limited: { credential_id: A, resets_at: sec(now + 2 * HOUR) },
      },
      () => now,
    );
    expect(result.credential_id).toBe(B);
    expect(without(writes, "claude_pool_reservations")).toEqual([
      {
        id: A,
        key: "claude_pool_limited",
        value: { until: new Date(now + 2 * HOUR).toISOString() },
      },
    ]);
  });

  it("holds until the earliest reset when nothing can take a turn", async () => {
    setup([
      { id: A, metadata: { claude_usage: usage(1, 0.1, 10 * HOUR) } },
      {
        id: B,
        metadata: {
          claude_pool_limited: {
            until: new Date(now + 3 * HOUR).toISOString(),
          },
        },
      },
    ]);
    expect(
      await pickClaudePool({ account_id, target: target("t1") }, () => now),
    ).toEqual({
      hold_until: new Date(now + 2 * HOUR).toISOString(),
      next_credential_id: A,
    });
  });

  it("spreads simultaneous turns using reservations", async () => {
    setup([
      { id: A, metadata: { claude_usage: usage(0.82, 0.1, 10 * HOUR) } },
      { id: B, metadata: { claude_usage: usage(0.2, 0.1, 100 * HOUR) } },
    ]);
    const picks = await Promise.all(
      ["t1", "t2", "t3", "t4", "t5", "t6", "t7"].map((thread) =>
        pickClaudePool({ account_id, target: target(thread) }, () => now),
      ),
    );
    // A takes turns until a heavy one no longer fits beside the reserved ones.
    const onA = picks.filter((p) => p.credential_id === A).length;
    expect(onA).toBeGreaterThan(0);
    expect(onA).toBeLessThan(picks.length);
    // A later turn of the same conversation replaces its reservation.
    const again = await pickClaudePool(
      {
        account_id,
        target: target("t1"),
        current_credential_id: picks[0].credential_id,
      },
      () => now,
    );
    expect(again.credential_id).toBe(picks[0].credential_id);
  });

  it("stores valid turn costs for the account's own subscriptions only", async () => {
    const writes = setup([{ id: A, metadata: {} }]);
    await pickClaudePool(
      {
        account_id,
        target: target("t1"),
        turn_costs: [
          { credential_id: A, cost: 0.04 },
          { credential_id: A, cost: 7 },
          { credential_id: B, cost: 0.1 },
        ],
      },
      () => now,
    );
    expect(without(writes, "claude_pool_reservations")).toEqual([
      { id: A, key: "claude_turn_costs", value: { samples: [0.04] } },
    ]);
  });

  it("rejects an invalid account or conversation", async () => {
    setup([]);
    await expect(
      pickClaudePool({ account_id: "x", target: target("t1") }, () => now),
    ).rejects.toThrow();
    await expect(
      pickClaudePool(
        { account_id, target: { project_id: "x", thread_id: "t" } },
        () => now,
      ),
    ).rejects.toThrow();
  });
});

describe("reservations on the credentials", () => {
  it("are stored opaquely, replaced by the conversation's next turn, and expire", async () => {
    const rows = [
      { id: A, metadata: { claude_usage: usage(0.1, 0.1, 10 * HOUR) } },
    ];
    setup(rows);
    await pickClaudePool({ account_id, target: target("t1") }, () => now);
    const stored = (rows[0].metadata as any).claude_pool_reservations;
    const keys = Object.keys(stored);
    expect(keys).toHaveLength(1);
    // No project or thread id in the owner's credential metadata.
    expect(keys[0]).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(stored)).not.toMatch(/t1|2222/);
    await pickClaudePool({ account_id, target: target("t1") }, () => now);
    expect(
      Object.keys((rows[0].metadata as any).claude_pool_reservations),
    ).toEqual(keys);
    await pickClaudePool({ account_id, target: target("t2") }, () => now);
    expect(
      Object.keys((rows[0].metadata as any).claude_pool_reservations),
    ).toHaveLength(2);
    // Later, another account's turn is not needed to drop expired ones:
    // the next pick for this account prunes them.
    await pickClaudePool(
      { account_id, target: target("t3") },
      () => now + 11 * 60_000,
    );
    expect(
      Object.keys((rows[0].metadata as any).claude_pool_reservations),
    ).toHaveLength(1);
  });
});
