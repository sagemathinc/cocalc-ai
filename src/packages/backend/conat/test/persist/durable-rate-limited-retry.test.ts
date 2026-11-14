/*
028 B-3a (ops0 3568): the persist client resends a request the server refused
with `rate_limited` (the owner's write budget), on EVERY write path, until its
retry window has passed.  A refused request was not applied, so a resend
can't apply it twice: each call below is refused k times, then admitted, and
costs the budget exactly ONE transaction.  The budget runs on a frozen clock
so the token count is exact.

pnpm test ./durable-rate-limited-retry.test.ts
*/

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import {
  stream,
  rateLimitedRetryStats,
  setRateLimitedRetryMsForTests,
} from "@cocalc/conat/persist/client";
import {
  ownerBudget,
  resetBudgetsForTests,
} from "@cocalc/conat/persist/write-budget";
import { messageData } from "@cocalc/conat/core/client";

const ENV = [
  "COCALC_PERSIST_HOST_TXN_PER_SEC",
  "COCALC_PERSIST_HOST_TXN_BURST",
  "COCALC_PERSIST_HOST_BYTES_PER_SEC",
  "COCALC_PERSIST_HOST_BYTES_BURST",
];
const saved: Record<string, string | undefined> = {};

// the frozen budget clock
let now = 1_800_000_000_000;

beforeAll(async () => {
  await before();
  for (const k of ENV) saved[k] = process.env[k];
  // "hub/..." streams belong to the host owner: 1 txn per second, burst 1
  process.env.COCALC_PERSIST_HOST_TXN_PER_SEC = "1";
  process.env.COCALC_PERSIST_HOST_TXN_BURST = "1";
  process.env.COCALC_PERSIST_HOST_BYTES_PER_SEC = "1e12";
  process.env.COCALC_PERSIST_HOST_BYTES_BURST = "1e12";
});

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] == null) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetBudgetsForTests();
  setRateLimitedRetryMsForTests(60_000);
  await after();
});

jest.setTimeout(30_000);

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("028 B-3a: every write path resends a rate_limited refusal; one admission, one charge", () => {
  let s;
  const host = () => ownerBudget("host");

  it("opens a host-owned stream; the budget starts full on the frozen clock", async () => {
    s = stream({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `hub/rate-limited-retry-${Math.random()}` },
    });
    // open it (the open-time writes are not charged), then start the budget
    await s.getMetadata();
    resetBudgetsForTests(() => now);
    expect(host().snapshot().txn).toBe(1);
  });

  // [the path, a call that writes, a check that it was applied]
  const paths: Array<[string, () => Promise<any>, () => Promise<void>]> = [
    [
      "setMetadata",
      () => s.setMetadata({ v: 1 }),
      async () => expect(await s.getMetadata()).toEqual({ v: 1 }),
    ],
    [
      "patchMetadata",
      () => s.patchMetadata({ w: 2 }),
      async () => expect(await s.getMetadata()).toEqual({ v: 1, w: 2 }),
    ],
    [
      "set",
      () => s.set({ key: "k", messageData: messageData("x") }),
      async () => expect((await s.get({ key: "k" }))?.data).toBe("x"),
    ],
    [
      "config",
      () => s.config({ config: { max_msgs: 100 } }),
      // a config READ may run the limit-enforcement transaction, which is
      // charged too: refill first
      async () => {
        now += 1000;
        expect((await s.config({})).max_msgs).toBe(100);
      },
    ],
    [
      "setCheckpoint",
      () => s.setCheckpoint({ name: "cp", seq: 1, data: { a: 1 } }),
      async () =>
        expect(Object.keys(await s.getCheckpoints())).toContain("cp"),
    ],
    [
      "deleteCheckpoint",
      () => s.deleteCheckpoint("cp"),
      async () =>
        expect(Object.keys(await s.getCheckpoints())).not.toContain("cp"),
    ],
    [
      "delete",
      () => s.delete({ all: true }),
      async () => expect(await s.get({ key: "k" })).toBeUndefined(),
    ],
  ];

  for (const [name, call, applied] of paths) {
    it(`${name}: refused 3 times, then admitted once, charged once`, async () => {
      // spend the one token, so the call is refused
      now += 1000;
      expect(host().snapshot().txn).toBe(1);
      host().commit({ txn: 1, bytes: 0 });
      expect(host().snapshot().txn).toBe(0);
      const before = rateLimitedRetryStats.refused;
      const p = call();
      await until(() => rateLimitedRetryStats.refused >= before + 3);
      // refill exactly one token: the next resend is admitted
      now += 1000;
      await p;
      // exactly ONE transaction was charged (a second apply would be -1)
      expect(host().snapshot().txn).toBe(0);
      await applied();
    });
  }

  it("the caller gets rate_limited only after the retry window, and nothing was applied", async () => {
    setRateLimitedRetryMsForTests(600);
    now += 1000;
    host().commit({ txn: 1, bytes: 0 });
    expect(host().snapshot().txn).toBe(0);
    const gaveUp = rateLimitedRetryStats.gaveUp;
    const t0 = Date.now();
    await expect(s.setMetadata({ v: "never" })).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
    expect(rateLimitedRetryStats.gaveUp).toBe(gaveUp + 1);
    expect(host().snapshot().txn).toBe(0);
    now += 1000;
    expect((await s.getMetadata())?.v).not.toBe("never");
  });
});
