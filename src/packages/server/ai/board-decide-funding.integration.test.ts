/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { getAIUsageStatus } from "./usage-status";
import { siteFundedDecideFunding } from "./board-decide-funding";
import { DECIDE_LIMITS } from "./board-decide";

jest.mock("./usage-status", () => ({ getAIUsageStatus: jest.fn() }));

const accountId = uuid();
const funding = siteFundedDecideFunding({ model: "typesafe/jev-1.14" });

beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    `INSERT INTO accounts(account_id, created, email_address)
     VALUES($1, NOW(), $2)`,
    [accountId, `${accountId}@example.com`],
  );
});

afterAll(after);

async function rows(requestId: string) {
  const { rows } = await getPool().query(
    `SELECT tag, cost_microusd FROM ai_usage_log WHERE account_id=$1 AND funded_event_id=$2`,
    [accountId, requestId],
  );
  return rows.map((r) => ({ tag: r.tag, cost: Number(r.cost_microusd) }));
}

describe("site-funded board decide", () => {
  beforeEach(() => {
    const now = Date.now();
    jest.mocked(getAIUsageStatus).mockResolvedValue({
      units_per_dollar: 100_000,
      windows: [
        {
          window: "5h",
          used: 0,
          limit: 0.1, // usage units (100 per dollar): $0.001, i.e. 1,000 micro-dollars
          starts_at: new Date(now - 60_000),
          resets_at: new Date(now + 5 * 60 * 60_000),
        },
      ],
    } as any);
  });

  it("holds, then commits the reported cost", async () => {
    const requestId = uuid();
    const r = await funding.reserve({ accountId, requestId, microusd: 2 });
    expect(await rows(requestId)).toEqual([
      { tag: "board-decide-reservation", cost: 2 },
    ]);
    await r.commit(1);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 1 }]);
  });

  it("records a cost above the hold in full", async () => {
    const requestId = uuid();
    const r = await funding.reserve({ accountId, requestId, microusd: 2 });
    await r.commit(5);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 5 }]);
  });

  it("releases a hold when the call fails", async () => {
    const requestId = uuid();
    const r = await funding.reserve({ accountId, requestId, microusd: 2 });
    await r.release();
    // kept at no cost, so it still counts toward the minute's limit
    expect(await rows(requestId)).toEqual([
      { tag: "board-decide-released", cost: 0 },
    ]);
  });

  // Codex on #1134: the per-account limit holds across hub replicas, so it
  // is counted in the database under the account's lock, not per process.
  it("at most callsPerAccountPerMinute a minute, across replicas", async () => {
    const account = uuid();
    await getPool().query(
      `INSERT INTO accounts(account_id, created, email_address)
       VALUES($1, NOW(), $2)`,
      [account, `${account}@example.com`],
    );
    // two replicas: each its own funding, nothing shared but the database
    const replicas = [
      siteFundedDecideFunding({ model: "typesafe/jev-1.14" }),
      siteFundedDecideFunding({ model: "typesafe/jev-1.14" }),
    ];
    const n = DECIDE_LIMITS.callsPerAccountPerMinute;
    const held = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        replicas[i % 2].reserve({
          accountId: account,
          requestId: uuid(),
          microusd: 1,
        }),
      ),
    );
    // done, failed or still held: each counts
    await held[0].commit(1);
    await held[1].release();
    for (const replica of replicas) {
      await expect(
        replica.reserve({ accountId: account, requestId: uuid(), microusd: 1 }),
      ).rejects.toMatchObject({ code: 429 });
    }
    // a minute later there is room again
    await getPool().query(
      `UPDATE ai_usage_log SET time = time - INTERVAL '61 seconds'
       WHERE account_id=$1`,
      [account],
    );
    await expect(
      replicas[1].reserve({
        accountId: account,
        requestId: uuid(),
        microusd: 1,
      }),
    ).resolves.toBeDefined();
  });

  it("refuses when the allowance has no room, or there is no allowance", async () => {
    await expect(
      funding.reserve({ accountId, requestId: uuid(), microusd: 10_000_000 }),
    ).rejects.toMatchObject({ code: 403 });
    jest
      .mocked(getAIUsageStatus)
      .mockResolvedValueOnce({ units_per_dollar: 100_000, windows: [] } as any);
    await expect(
      funding.reserve({ accountId, requestId: uuid(), microusd: 1 }),
    ).rejects.toMatchObject({ code: 403 });
  });
});
