/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { after, before } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";
import { getAIUsageStatus } from "./usage-status";
import { siteFundedDecideFunding } from "./board-decide-funding";
import {
  boardDecide,
  DECIDE_LIMITS,
  resetBoardDecideStateForTests,
  type DecideProvider,
} from "./board-decide";

jest.mock("./usage-status", () => ({ getAIUsageStatus: jest.fn() }));

const accountId = uuid();
const funding = siteFundedDecideFunding({ model: "typesafe/jev-1.14" });
// The board a call is for, as the file's server resolved it.
const BOARD_KEY = {
  projectId: "44444444-4444-4444-8444-444444444444",
  path: "/home/user/plan.board.json",
};

beforeAll(async () => {
  await before({ noConat: true });
  await getPool().query(
    `INSERT INTO accounts(account_id, created, email_address)
     VALUES($1, NOW(), $2)`,
    [accountId, `${accountId}@example.com`],
  );
});

afterAll(after);

async function globalHolds(requestId: string) {
  const { rows } = await getPool().query(
    `SELECT status, committed_microusd FROM site_ai_speech_reservations
     WHERE request_id=$1`,
    [requestId],
  );
  return rows.map((r) => ({
    status: r.status,
    committed: Number(r.committed_microusd),
  }));
}

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
    const r = await funding.reserve({
      board: BOARD_KEY,
      accountId,
      requestId,
      microusd: 2,
    });
    expect(await rows(requestId)).toEqual([
      { tag: "board-decide-reservation", cost: 2 },
    ]);
    await r.commit(1);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 1 }]);
  });

  it("records a cost above the hold in full", async () => {
    const requestId = uuid();
    const r = await funding.reserve({
      board: BOARD_KEY,
      accountId,
      requestId,
      microusd: 2,
    });
    await r.commit(5);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 5 }]);
  });

  it("releases a hold when the call fails", async () => {
    const requestId = uuid();
    const r = await funding.reserve({
      board: BOARD_KEY,
      accountId,
      requestId,
      microusd: 2,
    });
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
          board: BOARD_KEY,
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
        replica.reserve({
          board: BOARD_KEY,
          accountId: account,
          requestId: uuid(),
          microusd: 1,
        }),
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
        board: BOARD_KEY,
        accountId: account,
        requestId: uuid(),
        microusd: 1,
      }),
    ).resolves.toBeDefined();
  });

  // Codex on #1134: the per-board hourly limit holds across hub replicas
  // too: counted in the database under the account's lock, by the board
  // (project and resolved path) on each hold's row.
  it("at most callsPerBoardPerHour an hour on one board, across replicas", async () => {
    const account = uuid();
    await getPool().query(
      `INSERT INTO accounts(account_id, created, email_address)
       VALUES($1, NOW(), $2)`,
      [account, `${account}@example.com`],
    );
    const replicas = [
      siteFundedDecideFunding({ model: "typesafe/jev-1.14" }),
      siteFundedDecideFunding({ model: "typesafe/jev-1.14" }),
    ];
    const board = BOARD_KEY;
    const other = { ...BOARD_KEY, path: "/home/user/other.board.json" };
    const age = async (interval: string) =>
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '${interval}'
         WHERE account_id=$1`,
        [account],
      );
    const perMinute = DECIDE_LIMITS.callsPerAccountPerMinute;
    const perHour = DECIDE_LIMITS.callsPerBoardPerHour;
    let made = 0;
    let first: any;
    // In batches the minute limit allows, alternating replicas; each
    // batch then a minute older.
    while (made < perHour) {
      const n = Math.min(perMinute, perHour - made);
      const held = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          replicas[(made + i) % 2].reserve({
            board,
            accountId: account,
            requestId: uuid(),
            microusd: 1,
          }),
        ),
      );
      if (made === 0) {
        first = held[0];
        // held[1] is never settled: a hold whose hub died.
        await first.release(); // a failed call counts, for the hour
        for (const h of held.slice(2)) await h.commit(1);
      } else {
        for (const h of held) await h.commit(1);
      }
      made += n;
      await age("61 seconds");
    }
    // The failed call and the stale hold (its hub "died": never settled)
    // are past their 5 minutes now, and still count.
    await age("5 minutes");
    for (const replica of replicas) {
      await expect(
        replica.reserve({
          board,
          accountId: account,
          requestId: uuid(),
          microusd: 1,
        }),
      ).rejects.toMatchObject({
        code: 429,
        message: expect.stringMatching(/on this board/),
      });
    }
    // Another board of the same account has room.
    await expect(
      replicas[1].reserve({
        board: other,
        accountId: account,
        requestId: uuid(),
        microusd: 1,
      }),
    ).resolves.toBeDefined();
    // The stale hold was released, at no cost, not dropped (by the
    // reservation that succeeded: a refused one rolls back).
    const { rows } = await getPool().query(
      `SELECT tag, COUNT(*) AS n, SUM(cost_microusd) AS cost
       FROM ai_usage_log WHERE account_id=$1 GROUP BY tag ORDER BY tag`,
      [account],
    );
    expect(
      rows.map((r) => ({ tag: r.tag, n: Number(r.n), cost: Number(r.cost) })),
    ).toEqual([
      { tag: "board-decide", n: perHour - 2, cost: perHour - 2 },
      { tag: "board-decide-released", n: 2, cost: 0 },
      { tag: "board-decide-reservation", n: 1, cost: 1 },
    ]);
    // An hour later, this board has room again.
    await age("1 hour");
    await expect(
      replicas[0].reserve({
        board,
        accountId: account,
        requestId: uuid(),
        microusd: 1,
      }),
    ).resolves.toBeDefined();
  });

  it("refuses when the allowance has no room, or there is no allowance", async () => {
    await expect(
      funding.reserve({
        board: BOARD_KEY,
        accountId,
        requestId: uuid(),
        microusd: 10_000_000,
      }),
    ).rejects.toMatchObject({ code: 403 });
    jest
      .mocked(getAIUsageStatus)
      .mockResolvedValueOnce({ units_per_dollar: 100_000, windows: [] } as any);
    await expect(
      funding.reserve({
        board: BOARD_KEY,
        accountId,
        requestId: uuid(),
        microusd: 1,
      }),
    ).rejects.toMatchObject({ code: 403 });
  });

  // A request id in flight is refused by its durable global hold, not only
  // by the per-process map: two calls with the same id, at once (as on two
  // replicas), make one reservation, and only it settles the site hold.
  it("the same request id at once: one reservation, settled once", async () => {
    const requestId = uuid();
    const [a, b] = await Promise.allSettled([
      funding.reserve({ board: BOARD_KEY, accountId, requestId, microusd: 2 }),
      funding.reserve({ board: BOARD_KEY, accountId, requestId, microusd: 2 }),
    ]);
    const won = [a, b].filter((r) => r.status === "fulfilled");
    const lost = [a, b].filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 409,
    });
    expect(await globalHolds(requestId)).toEqual([
      { status: "active", committed: 0 },
    ]);
    await (won[0] as PromiseFulfilledResult<any>).value.commit(1);
    expect(await globalHolds(requestId)).toEqual([
      { status: "committed", committed: 1 },
    ]);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 1 }]);
  });

  it("a replay while the first call is active, its local guard forgotten, is refused", async () => {
    const requestId = uuid();
    const question = {
      prompt: "Which?",
      options: [{ name: "yes" }, { name: "no" }],
    };
    let finish!: () => void;
    const decide = jest.fn(
      () =>
        new Promise<any>((resolve) => {
          finish = () =>
            resolve({
              options: [
                { name: "yes", p: 0.9 },
                { name: "no", p: 0.1 },
              ],
              confidence: 0.9,
              costMicrousd: 1,
            });
        }),
    );
    const provider: DecideProvider = {
      maxCostMicrousd: () => 2,
      decide,
    } as any;
    resetBoardDecideStateForTests();
    const first = boardDecide({
      board: BOARD_KEY,
      accountId,
      requestId,
      question,
      answer: "yes",
      provider,
      funding,
    });
    while (decide.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // As if this process had evicted the id, or the replay reached
    // another replica.
    resetBoardDecideStateForTests();
    await expect(
      boardDecide({
        board: BOARD_KEY,
        accountId,
        requestId,
        question,
        answer: "yes",
        provider,
        funding,
      }),
    ).rejects.toMatchObject({ code: 409 });
    expect(decide).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toBeDefined();
    expect(await globalHolds(requestId)).toEqual([
      { status: "committed", committed: 1 },
    ]);
    expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 1 }]);
    // And once finished, the id is still refused.
    resetBoardDecideStateForTests();
    await expect(
      boardDecide({
        board: BOARD_KEY,
        accountId,
        requestId,
        question,
        answer: "yes",
        provider,
        funding,
      }),
    ).rejects.toMatchObject({ code: 409 });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  // A COMMIT that throws may have committed (its reply lost). The hold's
  // row is read back: there, the reservation stands; not there, the hold
  // is released; unreadable, the hold is kept and both go lazily.
  describe("a COMMIT that throws", () => {
    const pool: any = getPool();
    // The funding's own COMMIT (the one after its hold row's INSERT; the
    // global reservation commits on another connection first): applied
    // then throws, or throws unapplied. Once.
    function nextCommit(applied: boolean) {
      const realConnect = pool.connect.bind(pool);
      let fired = false;
      jest.spyOn(pool, "connect").mockImplementation(async () => {
        const c = await realConnect();
        const query = c.query.bind(c);
        let inserted = false;
        c.query = async (text: any, ...rest: any[]) => {
          if (typeof text === "string") {
            if (/^\s*INSERT INTO ai_usage_log/.test(text)) inserted = true;
            if (inserted && !fired && /^\s*COMMIT/.test(text)) {
              fired = true;
              if (applied) await query(text, ...rest);
              throw new Error("COMMIT reply lost");
            }
          }
          return await query(text, ...rest);
        };
        return c;
      });
    }
    afterEach(() => jest.restoreAllMocks());

    it("applied, and read back: the reservation stands and settles once", async () => {
      const requestId = uuid();
      nextCommit(true);
      const r = await funding.reserve({
        board: BOARD_KEY,
        accountId,
        requestId,
        microusd: 2,
      });
      expect(await globalHolds(requestId)).toEqual([
        { status: "active", committed: 0 },
      ]);
      await r.commit(1);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 1 },
      ]);
      expect(await rows(requestId)).toEqual([{ tag: "board-decide", cost: 1 }]);
    });

    it("not applied: the hold is released once and nothing is written", async () => {
      const requestId = uuid();
      nextCommit(false);
      await expect(
        funding.reserve({
          board: BOARD_KEY,
          accountId,
          requestId,
          microusd: 2,
        }),
      ).rejects.toThrow("COMMIT reply lost");
      expect(await globalHolds(requestId)).toEqual([
        { status: "released", committed: 0 },
      ]);
      expect(await rows(requestId)).toEqual([]);
    });

    it("applied, but unreadable: both holds kept, then cleaned up lazily", async () => {
      const requestId = uuid();
      nextCommit(true);
      const realQuery = pool.query.bind(pool);
      jest
        .spyOn(pool, "query")
        .mockImplementation(async (text: any, ...rest: any[]) => {
          if (
            typeof text === "string" &&
            /SELECT 1 FROM ai_usage_log/.test(text)
          )
            throw new Error("database unavailable");
          return await realQuery(text, ...rest);
        });
      await expect(
        funding.reserve({
          board: BOARD_KEY,
          accountId,
          requestId,
          microusd: 2,
        }),
      ).rejects.toThrow("COMMIT reply lost");
      jest.restoreAllMocks();
      // Kept, not released: the outcome was unknown.
      expect(await globalHolds(requestId)).toEqual([
        { status: "active", committed: 0 },
      ]);
      expect(await rows(requestId)).toEqual([
        { tag: "board-decide-reservation", cost: 2 },
      ]);
      // Past their 5 minutes, nothing has changed by itself (no background
      // job): a later reservation in the site pool expires the global hold,
      // and this account's next reservation that commits releases its row.
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id=$2`,
        [accountId, requestId],
      );
      await getPool().query(
        `UPDATE site_ai_speech_reservations
         SET expires_at = NOW() - INTERVAL '1 second' WHERE request_id=$1`,
        [requestId],
      );
      expect(await rows(requestId)).toEqual([
        { tag: "board-decide-reservation", cost: 2 },
      ]);
      const next = await funding.reserve({
        board: BOARD_KEY,
        accountId,
        requestId: uuid(),
        microusd: 1,
      });
      expect((await globalHolds(requestId))[0].status).toBe("expired");
      expect(await rows(requestId)).toEqual([
        { tag: "board-decide-released", cost: 0 },
      ]);
      // still counted for the board's hour
      const { rows: hour } = await getPool().query(
        `SELECT COUNT(*) AS n FROM ai_usage_log
         WHERE account_id=$1 AND funded_event_id=$2 AND project_id=$3
           AND path=$4 AND time > NOW() - INTERVAL '1 hour'`,
        [accountId, requestId, BOARD_KEY.projectId, BOARD_KEY.path],
      );
      expect(Number(hour[0].n)).toBe(1);
      await next.release();
    });
  });

  // Codex on #1134: after a successful provider call, settlement never
  // ends with the site pool charged and the account released. The hold
  // row is CALLING from before the call; each step is retried; a stale
  // CALLING row is finished as a charge, its global hold settled.
  describe("settlement after the provider succeeded", () => {
    const pool: any = getPool();
    const reservations = require("./site-funded-speech-reservations");
    afterEach(() => jest.restoreAllMocks());
    // a fresh account each test: clear of the minute limit
    let acct = "";
    beforeEach(async () => {
      acct = uuid();
      await getPool().query(
        `INSERT INTO accounts(account_id, created, email_address)
         VALUES($1, NOW(), $2)`,
        [acct, `${acct}@example.com`],
      );
    });
    async function rowsOf(requestId: string) {
      const { rows } = await getPool().query(
        `SELECT tag, cost_microusd FROM ai_usage_log
         WHERE account_id=$1 AND funded_event_id=$2`,
        [acct, requestId],
      );
      return rows.map((r) => ({ tag: r.tag, cost: Number(r.cost_microusd) }));
    }
    // Make the account UPDATE whose 4th parameter matches fail `times`
    // times ("[board-decide]": recording the cost; "board-decide":
    // marking it settled).
    function failAccountStep(param4: string, times = Infinity) {
      const real = pool.query.bind(pool);
      let n = 0;
      jest
        .spyOn(pool, "query")
        .mockImplementation(async (text: any, params?: any) => {
          if (
            typeof text === "string" &&
            /UPDATE ai_usage_log SET/.test(text) &&
            /tag = ANY/.test(text) &&
            params?.[3] === param4 &&
            n < times
          ) {
            n++;
            throw new Error("home database unavailable");
          }
          return await real(text, params);
        });
    }
    async function called(requestId: string) {
      const r = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId,
        microusd: 3,
      });
      await r.calling();
      return r;
    }
    // Past the 5-minute TTL; then the account's next reservation finishes it.
    async function finishStale(requestId: string) {
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id=$2`,
        [acct, requestId],
      );
      const next = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId: uuid(),
        microusd: 1,
      });
      await next.release();
    }

    it("marking it settled fails: the row keeps the cost, and is charged it when finished", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      failAccountStep("board-decide");
      await r.commit(2); // doesn't refuse the answer
      jest.restoreAllMocks();
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-calling", cost: 2 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
      await finishStale(requestId);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
    });

    it("recording the cost fails: charged the reserved bound, never released", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      failAccountStep("[board-decide]");
      await r.commit(2);
      jest.restoreAllMocks();
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-calling", cost: 3 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
      await finishStale(requestId);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 3 },
      ]);
    });

    it("a transient failure is retried: charged the cost at once", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      failAccountStep("[board-decide]", 1);
      await r.commit(2);
      jest.restoreAllMocks();
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
    });

    it("the reverse, the site pool fails: the account is charged and the hold settled when finished", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      const realFinish = reservations.finishSiteFundedSpeechGlobal;
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockImplementation(async (o: any) => {
          if (o.requestId === requestId)
            throw new Error("seed bay unreachable");
          return await realFinish(o);
        });
      await r.commit(2);
      jest.restoreAllMocks();
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-calling", cost: 2 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "active", committed: 0 },
      ]);
      await finishStale(requestId);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
    });

    // daybreak2: an update that finds no row is retried, not taken as done.
    it("marking it settled that changes no row is retried", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      const real = pool.query.bind(pool);
      let missed = false;
      jest
        .spyOn(pool, "query")
        .mockImplementation(async (text: any, params?: any) => {
          if (
            !missed &&
            typeof text === "string" &&
            /UPDATE ai_usage_log SET/.test(text) &&
            /tag = ANY/.test(text) &&
            params?.[3] === "board-decide"
          ) {
            missed = true;
            return { rows: [] }; // as if the row weren't there yet
          }
          return await real(text, params);
        });
      await r.commit(2);
      jest.restoreAllMocks();
      expect(missed).toBe(true);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
    });

    // astra (CORR-E31-1): a site-pool settle that fails on the stale pass
    // too leaves the row pending, and a later pass settles it.
    it("the stale pass's site-pool settle fails too: a later pass settles it", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      const realFinish = reservations.finishSiteFundedSpeechGlobal;
      let failing = true;
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockImplementation(async (o: any) => {
          if (failing && o.requestId === requestId)
            throw new Error("seed bay unreachable");
          return await realFinish(o);
        });
      await r.commit(2);
      await finishStale(requestId); // the stale pass fails as well
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-calling", cost: 2 },
      ]);
      failing = false;
      // past the per-row backoff
      require("./board-decide-funding").resetPendingSettleBackoffForTests();
      const again = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId: uuid(),
        microusd: 1,
      });
      await again.release();
      jest.restoreAllMocks();
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
    });

    // astra (CORR-E31-2): both holds past their 5 minutes, in the real
    // order: another reservation expires the site-pool hold first. The
    // pending row is then charged late, never a silent no-op.
    it("the site-pool hold expired first: charged late, then committed", async () => {
      const requestId = uuid();
      const r = await called(requestId);
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockRejectedValue(new Error("seed bay unreachable"));
      await r.commit(2);
      jest.restoreAllMocks();
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id=$2`,
        [acct, requestId],
      );
      await getPool().query(
        `UPDATE site_ai_speech_reservations
         SET expires_at = NOW() - INTERVAL '1 second' WHERE request_id=$1`,
        [requestId],
      );
      // another account's reservation expires it
      const other = uuid();
      await getPool().query(
        `INSERT INTO accounts(account_id, created, email_address)
         VALUES($1, NOW(), $2)`,
        [other, `${other}@example.com`],
      );
      const theirs = await funding.reserve({
        board: BOARD_KEY,
        accountId: other,
        requestId: uuid(),
        microusd: 1,
      });
      await theirs.release();
      expect(await globalHolds(requestId)).toEqual([
        { status: "expired", committed: 0 },
      ]);
      const next = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId: uuid(),
        microusd: 1,
      });
      await next.release();
      expect(await globalHolds(requestId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
    });

    // astra (CORR-E31-1): the reservation recovered after a lost COMMIT
    // reply settles pending calls like any other.
    it("a reservation recovered from a lost COMMIT reply settles pending calls too", async () => {
      const pendingId = uuid();
      const r = await called(pendingId);
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockRejectedValue(new Error("seed bay unreachable"));
      await r.commit(2);
      jest.restoreAllMocks();
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id=$2`,
        [acct, pendingId],
      );
      // the next reservation's own COMMIT applies, then its reply is lost
      const realConnect = pool.connect.bind(pool);
      let fired = false;
      jest.spyOn(pool, "connect").mockImplementation(async () => {
        const c = await realConnect();
        const query = c.query.bind(c);
        let inserted = false;
        c.query = async (text: any, ...rest: any[]) => {
          if (typeof text === "string") {
            if (/^\s*INSERT INTO ai_usage_log/.test(text)) inserted = true;
            if (inserted && !fired && /^\s*COMMIT/.test(text)) {
              fired = true;
              await query(text, ...rest);
              throw new Error("COMMIT reply lost");
            }
          }
          return await query(text, ...rest);
        };
        return c;
      });
      const recovered = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId: uuid(),
        microusd: 1,
      });
      jest.restoreAllMocks();
      expect(fired).toBe(true);
      await recovered.release();
      expect(await rowsOf(pendingId)).toEqual([
        { tag: "board-decide", cost: 2 },
      ]);
      expect(await globalHolds(pendingId)).toEqual([
        { status: "committed", committed: 2 },
      ]);
    });

    // daybreak2: the pending pass is bounded work on the request path.
    it("the pending pass is bounded: one attempt while failing, then batches drain", async () => {
      const { PENDING_SETTLE_BATCH } = require("./board-decide-funding");
      const n = PENDING_SETTLE_BATCH + 2;
      const ids: string[] = [];
      const realFinish = reservations.finishSiteFundedSpeechGlobal;
      let failing = true;
      const attempts: string[] = [];
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockImplementation(async (o: any) => {
          if (ids.includes(o.requestId)) {
            attempts.push(o.requestId);
            if (failing) throw new Error("seed bay unreachable");
          }
          return await realFinish(o);
        });
      for (let i = 0; i < n; i++) {
        const id = uuid();
        ids.push(id);
        const r = await called(id);
        await r.commit(2);
      }
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id = ANY($2::UUID[])`,
        [acct, ids],
      );
      const pendingCount = async () =>
        Number(
          (
            await getPool().query(
              `SELECT COUNT(*) AS n FROM ai_usage_log
               WHERE account_id=$1 AND tag='board-decide-calling'`,
              [acct],
            )
          ).rows[0].n,
        );
      const reserveOnce = async () =>
        await (
          await funding.reserve({
            board: BOARD_KEY,
            accountId: acct,
            requestId: uuid(),
            microusd: 1,
          })
        ).release();
      expect(await pendingCount()).toBe(n);
      // still failing: one attempt for the whole pass, not n
      attempts.length = 0;
      await reserveOnce();
      expect(attempts).toHaveLength(1);
      expect(await pendingCount()).toBe(n);
      // and the row just tried is not tried again by the next request
      // within the backoff: that one tries the next row only
      await reserveOnce();
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts).size).toBe(2);
      // recovered (and past the backoff): a batch a reservation, until drained
      failing = false;
      require("./board-decide-funding").resetPendingSettleBackoffForTests();
      attempts.length = 0;
      await reserveOnce();
      expect(attempts).toHaveLength(PENDING_SETTLE_BATCH);
      expect(await pendingCount()).toBe(n - PENDING_SETTLE_BATCH);
      await reserveOnce();
      expect(await pendingCount()).toBe(0);
      jest.restoreAllMocks();
      for (const id of ids) {
        expect(await globalHolds(id)).toEqual([
          { status: "committed", committed: 2 },
        ]);
      }
    });

    it("a site pool that doesn't answer can't stall admission", async () => {
      const { PENDING_SETTLE_BUDGET_MS } = require("./board-decide-funding");
      const requestId = uuid();
      const r = await called(requestId);
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockRejectedValue(new Error("seed bay unreachable"));
      await r.commit(2);
      jest.restoreAllMocks();
      await getPool().query(
        `UPDATE ai_usage_log SET time = time - INTERVAL '6 minutes'
         WHERE account_id=$1 AND funded_event_id=$2`,
        [acct, requestId],
      );
      const realFinish = reservations.finishSiteFundedSpeechGlobal;
      jest
        .spyOn(reservations, "finishSiteFundedSpeechGlobal")
        .mockImplementation(async (o: any) =>
          o.requestId === requestId
            ? await new Promise(() => {}) // never answers
            : await realFinish(o),
        );
      const started = Date.now();
      const next = await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId: uuid(),
        microusd: 1,
      });
      const took = Date.now() - started;
      jest.restoreAllMocks();
      await next.release();
      expect(took).toBeLessThan(PENDING_SETTLE_BUDGET_MS + 3000);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-calling", cost: 2 },
      ]);
    });

    it("a stale hold never called is still released at no cost", async () => {
      const requestId = uuid();
      await funding.reserve({
        board: BOARD_KEY,
        accountId: acct,
        requestId,
        microusd: 3,
      });
      await finishStale(requestId);
      expect(await rowsOf(requestId)).toEqual([
        { tag: "board-decide-released", cost: 0 },
      ]);
    });
  });
});
