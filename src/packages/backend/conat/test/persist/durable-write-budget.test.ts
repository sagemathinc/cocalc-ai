/*
Finding 028 B-3a: the server-held per-owner write budget (DESIGN v1.21
§3.2.9, vanta H3, @review H2; ops0 3550/3551).

One budget per logical owner (a project, or "host"), summed over all its
streams, as transaction and byte token buckets.  Committed-work accounting:
checked before a request is applied, against the bucket minus the batch's
charges so far; charged only after COMMIT returned OK.  A failed or rolled
back request spends nothing.  A charge larger than the burst is admitted
from a FULL bucket and drives it into debt (one big message is never refused
forever).  Over budget: a retryable `rate_limited`, counted.
*/

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";
import {
  MIN_TXN_BYTES,
  OwnerBudget,
  budgetStats,
  chargeFor,
  resetBudgetsForTests,
} from "@cocalc/conat/persist/write-budget";

const msg = (s: string | Buffer, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.isBuffer(s) ? s : Buffer.from(s),
  ...extra,
});

const MiB = 1024 * 1024;
const ENV = [
  "COCALC_PERSIST_PROJECT_TXN_PER_SEC",
  "COCALC_PERSIST_PROJECT_TXN_BURST",
  "COCALC_PERSIST_PROJECT_BYTES_PER_SEC",
  "COCALC_PERSIST_PROJECT_BYTES_BURST",
];

describe("028 B-3a: the bucket", () => {
  it("admits up to the burst, then refills at the rate", () => {
    let t = 0;
    const b = new OwnerBudget(
      { txnPerSecond: 2, txnBurst: 3, bytesPerSecond: 1e9, bytesBurst: 1e9 },
      () => t,
    );
    for (let i = 0; i < 3; i++) {
      expect(b.fits(chargeFor(1))).toBe(true);
      b.commit(chargeFor(1));
    }
    expect(b.fits(chargeFor(1))).toBe(false);
    t += 500; // +1 token
    expect(b.fits(chargeFor(1))).toBe(true);
  });

  it("checks against the batch's pending charges", () => {
    const b = new OwnerBudget(
      { txnPerSecond: 1, txnBurst: 2, bytesPerSecond: 1e9, bytesBurst: 1e9 },
      () => 0,
    );
    expect(b.fits(chargeFor(1), { txn: 1, bytes: 0 })).toBe(true);
    expect(b.fits(chargeFor(1), { txn: 2, bytes: 0 })).toBe(false);
  });

  it("every transaction costs at least MIN_TXN_BYTES bytes", () => {
    expect(chargeFor(0)).toEqual({ txn: 1, bytes: MIN_TXN_BYTES });
    expect(chargeFor(10 * MiB)).toEqual({ txn: 1, bytes: 10 * MiB });
  });

  it("a charge larger than the burst is admitted from a FULL bucket, alone, and drives it into debt; the next waits for the refill", () => {
    let t = 0;
    const b = new OwnerBudget(
      { txnPerSecond: 1e9, txnBurst: 1e9, bytesPerSecond: MiB, bytesBurst: MiB },
      () => t,
    );
    const big = chargeFor(3 * MiB);
    expect(b.fits(big)).toBe(true); // idle and full: admitted
    expect(b.fits(big, { txn: 1, bytes: 1 })).toBe(false); // not alone
    b.commit(big);
    expect(b.fits(chargeFor(0))).toBe(false); // in debt
    t += 2000; // still 0 tokens (debt -2 MiB + 2 MiB)
    expect(b.fits(big)).toBe(false);
    t += 1000; // full again
    expect(b.fits(big)).toBe(true);
  });
});

describe("028 B-3a: enforcement in the persist storage", () => {
  let dir: string;
  let streams: any[] = [];
  const saved: Record<string, string | undefined> = {};
  const project = "aaaaaaaa-2222-4333-8444-555555555555";
  const open = async (name: string, owner = project) => {
    const path = join(dir, name);
    await prepareDurableOpen(path, owner);
    const s = pstream({ path });
    clearOpenBarrierPass(path);
    streams.push(s);
    return s;
  };
  const limits = (txnBurst: number, bytesBurst = 1e12) => {
    process.env.COCALC_PERSIST_PROJECT_TXN_PER_SEC = "0.000001";
    process.env.COCALC_PERSIST_PROJECT_TXN_BURST = `${txnBurst}`;
    process.env.COCALC_PERSIST_PROJECT_BYTES_PER_SEC = "0.000001";
    process.env.COCALC_PERSIST_PROJECT_BYTES_BURST = `${bytesBurst}`;
    resetBudgetsForTests();
  };

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    dir = await mkdtemp(join(tmpdir(), "persist-028-budget-"));
    streams = [];
  });
  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    for (const k of ENV) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetBudgetsForTests();
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses with a retryable rate_limited once the project's budget is spent, and counts it", async () => {
    limits(3);
    const s = await open("a");
    for (let i = 0; i < 3; i++) await s.setQueued(msg(`${i}`));
    const before = budgetStats.refused_total;
    await expect(s.setQueued(msg("x"))).rejects.toMatchObject({
      code: "rate_limited",
    });
    expect(budgetStats.refused_total).toBe(before + 1);
  });

  it("one budget for ALL of a project's streams (many streams share it); another project is not affected", async () => {
    limits(4);
    const streamsOfProject = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => open(`s${i}`)),
    );
    let ok = 0;
    let refused = 0;
    for (const s of streamsOfProject) {
      try {
        await s.setQueued(msg("x"));
        ok += 1;
      } catch (err: any) {
        if (err.code == "rate_limited") refused += 1;
        else throw err;
      }
    }
    expect(ok).toBe(4);
    expect(refused).toBe(2);
    const other = await open("other", "bbbbbbbb-2222-4333-8444-555555555555");
    await other.setQueued(msg("y"));
  });

  it("a client config cannot lift it (the per-stream conf limits are a different thing)", async () => {
    limits(4);
    const s = await open("conf");
    // a real change of the per-stream limits (the defaults would write
    // nothing): exactly 1 txn
    const conf = s.config({
      max_msgs_per_second: 1_000_000,
      max_bytes_per_second: 1e12,
    } as any);
    expect(conf.max_msgs_per_second).toBe(1_000_000);
    for (let i = 0; i < 3; i++) await s.setQueued(msg(`${i}`));
    await expect(s.setQueued(msg("x"))).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("committed-work accounting: a request that fails (wrong previousSeq) spends nothing", async () => {
    limits(3);
    const s = await open("cas");
    const first = await s.setQueued(msg("v0", { key: "k" }));
    // two failures: not charged
    for (let i = 0; i < 2; i++) {
      await expect(
        s.setQueued(msg("v1", { key: "k", previousSeq: first.seq + 100 })),
      ).rejects.toThrow("wrong last sequence");
    }
    // the two remaining tokens are still there
    await s.setQueued(msg("a"));
    await s.setQueued(msg("b"));
    await expect(s.setQueued(msg("c"))).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("within one batch: requests beyond the budget fail alone; the others commit", async () => {
    limits(2);
    const s = await open("batch");
    const r = await Promise.allSettled([
      s.setQueued(msg("1")),
      s.setQueued(msg("2")),
      s.setQueued(msg("3")),
    ]);
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
    expect((r[2] as any).reason.code).toBe("rate_limited");
  });

  it("ORDER (SA-B3a-1): once a request is refused, every later request of the stream in the batch is refused too, even one that would fit", async () => {
    // 5000 bytes left: A (6000) can't fit, B (4096, the minimum charge) could
    limits(100, 9096);
    const s = await open("order");
    await s.setQueued(msg(Buffer.alloc(4096, 1))); // 4096 spent: 5000 left
    const before = s.getAll().length;
    const r = await Promise.allSettled([
      s.setQueued(msg(Buffer.alloc(6000, 2))), // A
      s.setQueued(msg(Buffer.alloc(100, 3))), // B: alone it would fit
    ]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(r.map((x) => (x as any).reason?.code)).toEqual(["rate_limited", "rate_limited"]);
    // nothing of the batch was applied: B did not commit ahead of A
    expect(s.getAll().length).toBe(before);
  });

  it("other mutating commands spend the budget too (config, metadata, delete)", async () => {
    limits(3);
    const s = await open("cmds");
    s.setMetadata({ a: 1 });
    s.config({ desc: "x" } as any);
    await s.setQueued(msg("x"));
    expect(() => s.setMetadata({ a: 2 })).toThrow(
      "faster than its write budget",
    );
  });

  it("one message larger than the byte burst is admitted on an idle project; the next waits", async () => {
    limits(1e9, 1 * MiB);
    const s = await open("big");
    const big = randomBytes(3 * MiB);
    await s.setQueued(msg(big));
    await expect(s.setQueued(msg("small"))).rejects.toMatchObject({
      code: "rate_limited",
    });
  });
});
