import {
  insertAgentTurnUsage,
  setTurnUsageTransactionForTests,
} from "./turn-usage";

const HOST = "00000000-0000-4000-8000-000000000501";
const usage = (thread_id: string) => ({
  project_id: "00000000-0000-4000-8000-000000000502",
  path: "a.chat",
  thread_id,
  provider: "claude",
  payment: "account-subscription",
  models: [
    {
      model: "m",
      input_tokens: 1,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  ],
  started_at: Date.now() - 60_000,
  ended_at: Date.now() - 1_000,
  outcome: "completed",
});

afterEach(() => setTurnUsageTransactionForTests());

test("a host's budget is counted under its lock, in one transaction per host", async () => {
  const transactions: string[][] = [];
  setTurnUsageTransactionForTests(async (fn) => {
    const sqls: string[] = [];
    transactions.push(sqls);
    return await fn({
      query: async (sql: string) => {
        sqls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
        if (sql.includes("count(*)")) return { rows: [{ n: 0 }] };
        return { rows: [], rowCount: 1 };
      },
    });
  });
  await expect(
    insertAgentTurnUsage({
      account_id: "00000000-0000-4000-8000-000000000503",
      rows: [
        { usage: usage("a"), host_id: HOST },
        { usage: usage("b"), host_id: HOST },
      ],
    }),
  ).resolves.toBe(2);
  expect(transactions).toHaveLength(1);
  const [sqls] = transactions;
  // The lock comes first, then the count, then the rows.
  expect(sqls[0]).toMatch(/^SELECT pg_advisory_xact_lock/);
  expect(sqls[1]).toMatch(/^SELECT count\(\*\)::int/);
  expect(sqls.filter((s) => s.startsWith("INSERT INTO"))).toHaveLength(2);
});
