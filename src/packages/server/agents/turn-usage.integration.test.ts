import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

let homeBay = "bay-a";
const remote = { recordTurnUsage: jest.fn() };

jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: homeBay }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-a",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/conat/inter-bay/agent-payment-selections", () => ({
  createAgentPaymentSelectionsClient: () => remote,
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () => ({
  assertAccountWriteOnHomeBay: async () => {},
}));
jest.mock("@cocalc/server/conat/api/project-host-token-auth", () => ({
  assertProjectHostAgentTokenAccess: async () => {},
}));

import {
  paymentSelectionsHome,
  recordAgentTurnUsageForAccount,
} from "./payment-selections";
import {
  MAX_TURNS_PER_HOST_PER_HOUR,
  setTurnUsageTransactionForTests,
  turnUsagePathHash,
} from "./turn-usage";
import { agentStore } from "./store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

const usage = (over: Record<string, unknown> = {}) => ({
  project_id: randomUUID(),
  path: ".local/share/cocalc/agents/a.chat",
  thread_id: "t1",
  provider: "claude",
  payment: "account-subscription",
  credential_id: randomUUID(),
  pool: true,
  models: [
    {
      model: "claude-opus-5-5",
      input_tokens: 10,
      cached_input_tokens: 1000,
      cache_write_tokens: 200,
      output_tokens: 50,
      reasoning_output_tokens: 0,
    },
    {
      model: "claude-haiku-5-5",
      input_tokens: 5,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
  ],
  started_at: Date.now() - 60_000,
  ended_at: Date.now(),
  outcome: "completed",
  ...over,
});

describeDb("agent turn usage (account home bay)", () => {
  beforeAll(async () => {
    await syncSchema({ agent_turn_usage: SCHEMA.agent_turn_usage });
  });
  beforeEach(() => {
    homeBay = "bay-a";
    remote.recordTurnUsage.mockReset();
    setTurnUsageTransactionForTests();
  });

  test("stores each turn with its totals, on the home bay", async () => {
    const account_id = randomUUID();
    const turn = usage();
    const host_id = randomUUID();
    await expect(
      recordAgentTurnUsageForAccount(account_id, [
        { usage: turn, host_id },
        { usage: { ...turn, models: [] }, host_id },
      ]),
    ).resolves.toBe(1);
    const { rows } = await getPool().query(
      "SELECT * FROM agent_turn_usage WHERE account_id=$1",
      [account_id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      project_id: turn.project_id,
      path_hash: turnUsagePathHash(turn.path),
      thread_id: "t1",
      provider: "claude",
      payment: "account-subscription",
      credential_id: turn.credential_id,
      pool: true,
      outcome: "completed",
      host_id,
    });
    expect(Number(row.input_tokens)).toBe(15);
    expect(Number(row.cached_input_tokens)).toBe(1000);
    expect(Number(row.cache_write_tokens)).toBe(200);
    expect(Number(row.output_tokens)).toBe(51);
    expect(row.models).toEqual(turn.models);
    // No file names are stored.
    expect(JSON.stringify(row)).not.toContain("agents/a.chat");
    expect(new Date(row.ended_at).getTime()).toBeCloseTo(turn.ended_at, -3);
    expect(remote.recordTurnUsage).not.toHaveBeenCalled();
  });

  test("goes to the account's home bay when that is another bay", async () => {
    homeBay = "bay-b";
    remote.recordTurnUsage.mockResolvedValue({ recorded: 1 });
    const account_id = randomUUID();
    await expect(
      recordAgentTurnUsageForAccount(account_id, [{ usage: usage() }]),
    ).resolves.toBe(1);
    expect(remote.recordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({ account_id, home_bay_id: "bay-b" }),
    );
  });

  test("a stale route is refused by the home implementation", async () => {
    await expect(
      paymentSelectionsHome.recordTurnUsage({
        account_id: randomUUID(),
        home_bay_id: "bay-b",
        rows: [{ usage: usage() }],
      }),
    ).rejects.toThrow("stale");
  });

  test("a resent report (same turn) is stored once", async () => {
    const account_id = randomUUID();
    const turn = usage({ turn_id: randomUUID() });
    await expect(
      recordAgentTurnUsageForAccount(account_id, [{ usage: turn }]),
    ).resolves.toBe(1);
    await expect(
      recordAgentTurnUsageForAccount(account_id, [
        { usage: turn },
        { usage: turn },
      ]),
    ).resolves.toBe(0);
    const { rows } = await getPool().query(
      "SELECT id FROM agent_turn_usage WHERE account_id=$1",
      [account_id],
    );
    expect(rows.map((r) => r.id)).toEqual([turn.turn_id]);
  });

  test("one host stores at most its hourly budget", async () => {
    const account_id = randomUUID();
    const host_id = randomUUID();
    // The host already stored its budget less one turn this hour.
    await getPool().query(
      `INSERT INTO agent_turn_usage
         (account_id,id,project_id,path_hash,thread_id,provider,payment,models,
          outcome,started_at,ended_at,host_id)
       SELECT $1, gen_random_uuid(), $2, 'h', 't', 'claude', 'x', '[]'::jsonb,
              'completed', now(), now(), $3
         FROM generate_series(1, $4::int)`,
      [account_id, randomUUID(), host_id, MAX_TURNS_PER_HOST_PER_HOUR - 1],
    );
    await expect(
      recordAgentTurnUsageForAccount(account_id, [
        { usage: usage({ thread_id: "last" }), host_id },
        { usage: usage({ thread_id: "over" }), host_id },
        // Another host has its own budget.
        { usage: usage({ thread_id: "other" }), host_id: randomUUID() },
      ]),
    ).resolves.toBe(2);
    const { rows } = await getPool().query(
      "SELECT thread_id FROM agent_turn_usage WHERE account_id=$1 AND thread_id<>'t' ORDER BY thread_id",
      [account_id],
    );
    expect(rows.map((r) => r.thread_id)).toEqual(["last", "other"]);
  });

  test("concurrent reports cannot overspend a host's budget", async () => {
    const account_id = randomUUID();
    const host_id = randomUUID();
    const remaining = 20;
    await getPool().query(
      `INSERT INTO agent_turn_usage
         (account_id,id,project_id,path_hash,thread_id,provider,payment,models,
          outcome,started_at,ended_at,host_id)
       SELECT $1, gen_random_uuid(), $2, 'h', 't', 'claude', 'x', '[]'::jsonb,
              'completed', now(), now(), $3
         FROM generate_series(1, $4::int)`,
      [account_id, randomUUID(), host_id, MAX_TURNS_PER_HOST_PER_HOUR - remaining],
    );
    const stored = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        recordAgentTurnUsageForAccount(
          account_id,
          Array.from({ length: 10 }, (_, j) => ({
            usage: usage({ thread_id: `c${i}-${j}` }),
            host_id,
          })),
        ),
      ),
    );
    expect(stored.reduce((a, b) => a + b, 0)).toBe(remaining);
    const { rows } = await getPool().query(
      "SELECT count(*)::int AS n FROM agent_turn_usage WHERE host_id=$1",
      [host_id],
    );
    expect(rows[0].n).toBe(MAX_TURNS_PER_HOST_PER_HOUR);
  });

  test("refuses far-future turns, and one refused row keeps the rest", async () => {
    const account_id = randomUUID();
    let inserts = 0;
    setTurnUsageTransactionForTests((fn) =>
      agentStore().transaction((client) =>
        fn({
          query: async (sql: string, values?: unknown[]) => {
            // The database refuses the first row (inside the transaction).
            if (sql.includes("INSERT") && inserts++ === 0)
              await client.query("SELECT 1/0");
            return await client.query(sql, values as any[]);
          },
        }),
      ),
    );
    await expect(
      recordAgentTurnUsageForAccount(account_id, [
        { usage: usage({ thread_id: "refused-by-db" }) },
        {
          usage: usage({
            thread_id: "future",
            ended_at: Date.now() + 365 * 86_400_000,
          }),
        },
        { usage: usage({ thread_id: "kept" }) },
      ]),
    ).resolves.toBe(1);
    setTurnUsageTransactionForTests();
    const { rows } = await getPool().query(
      "SELECT thread_id FROM agent_turn_usage WHERE account_id=$1",
      [account_id],
    );
    expect(rows.map((r) => r.thread_id)).toEqual(["kept"]);
  });
});
