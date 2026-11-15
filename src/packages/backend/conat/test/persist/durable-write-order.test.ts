/*
028 B-3a (AS-B3-ORDER-1 / REVIEW-B3-1, SA 3381, astra and review design
notes): one client's writes commit in the order it issued them, also when the
write budget refuses some of them, ACROSS batches.

- the storage, with a connection's WriteOrderState (as server.ts passes it):
  a refusal in one batch blocks a later write in a LATER batch after a
  refill; a gap (a later write first); a stale copy after the client gave up;
  the other write paths (runOrdered);
- the client, with its sends intercepted: wseq reserved at issue, resends in
  wseq order whatever order the refusals arrive in, a new write waits behind
  a pending retry, a give-up moves the floor;
- server.ts: the state is per connection.

pnpm test ./durable-write-order.test.ts
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { before, after, connect } from "@cocalc/backend/conat/test/setup";
import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  stream as persistClient,
  setRateLimitedJitterForTests,
  setRateLimitedRetryMsForTests,
} from "@cocalc/conat/persist/client";
import {
  clearOpenBarrierPass,
  prepareDurableOpen,
} from "@cocalc/conat/persist/storage";
import { resetBudgetsForTests } from "@cocalc/conat/persist/write-budget";
import { WriteOrderState } from "@cocalc/conat/persist/write-order";

jest.setTimeout(30_000);

const msg = (s: Buffer) => ({ encoding: DataEncoding.JsonCodec, raw: s });
const ENV = [
  "COCALC_PERSIST_PROJECT_TXN_PER_SEC",
  "COCALC_PERSIST_PROJECT_TXN_BURST",
  "COCALC_PERSIST_PROJECT_BYTES_PER_SEC",
  "COCALC_PERSIST_PROJECT_BYTES_BURST",
];

async function until(cond: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("028 B-3a AS-B3-ORDER-1: the storage, with a connection's order state", () => {
  let dir: string;
  let streams: any[] = [];
  const saved: Record<string, string | undefined> = {};
  const project = "aaaaaaaa-3333-4333-8444-555555555555";
  const open = async (name: string) => {
    const path = join(dir, name);
    await prepareDurableOpen(path, project);
    const s = pstream({ path });
    clearOpenBarrierPass(path);
    streams.push(s);
    return s;
  };
  // bytes are the binding limit; refills only by resetting (a "refill")
  const limits = (bytesBurst: number) => {
    process.env.COCALC_PERSIST_PROJECT_TXN_PER_SEC = "0.000001";
    process.env.COCALC_PERSIST_PROJECT_TXN_BURST = "1000";
    process.env.COCALC_PERSIST_PROJECT_BYTES_PER_SEC = "0.000001";
    process.env.COCALC_PERSIST_PROJECT_BYTES_BURST = `${bytesBurst}`;
    resetBudgetsForTests();
  };
  const A = () => msg(Buffer.alloc(6000, 0x41));
  const B = () => msg(Buffer.alloc(100, 0x42));
  const sizes = (s: any) => [...s.getAll()].map((m: any) => m.raw.length);
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (err) {
      return (err as any)?.code;
    }
  };
  // 4096 spent of 9096: A (6000) doesn't fit, B (charged 4096) would
  const spend = async (s: any) => {
    limits(9096);
    await s.setQueued(msg(Buffer.alloc(4096, 0x30)));
  };

  beforeEach(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    dir = await mkdtemp(join(tmpdir(), "persist-028-order-"));
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

  it("ACROSS BATCHES: A refused in one batch; B, in a LATER batch where it would fit, is refused too; A's resend, then B's, commit in order", async () => {
    const s = await open("across");
    await spend(s);
    const st = new WriteOrderState();
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("rate_limited");
    // a separate batch: without the order it would commit (see the control)
    expect(await code(s.setQueued(B(), { state: st, wseq: 2, wfloor: 1 }))).toBe("rate_limited");
    expect(sizes(s)).toEqual([4096]);
    limits(1e12); // the refill
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("ok");
    expect(await code(s.setQueued(B(), { state: st, wseq: 2, wfloor: 2 }))).toBe("ok");
    expect(sizes(s)).toEqual([4096, 6000, 100]);
  });

  it("control: without an order (an in-process caller), the later batch's B commits ahead of A (what the order prevents)", async () => {
    const s = await open("control");
    await spend(s);
    expect(await code(s.setQueued(A()))).toBe("rate_limited");
    expect(await code(s.setQueued(B()))).toBe("ok");
    expect(sizes(s)).toEqual([4096, 100]);
  });

  it("the other write paths (runOrdered): a setMetadata after a refused set is refused, even one QUEUED in the same tick that would fit", async () => {
    const s = await open("paths");
    await spend(s);
    const st = new WriteOrderState();
    // A queued, not yet flushed; the metadata write drains it first
    const pa = s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 });
    expect(() => s.runOrdered({ state: st, wseq: 2, wfloor: 1 }, () => s.setMetadata({ x: 1 }))).toThrow(
      expect.objectContaining({ code: "rate_limited" }),
    );
    expect(await code(pa)).toBe("rate_limited");
    expect(s.getMetadata()).not.toEqual({ x: 1 });
    limits(1e12);
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("ok");
    s.runOrdered({ state: st, wseq: 2, wfloor: 2 }, () => s.setMetadata({ x: 1 }));
    expect(s.getMetadata()).toEqual({ x: 1 });
  });

  it("runOrdered drains the queue first: a queued set of the connection that IS admitted lets a following ordered write through in the same call (liveness; the gap rule alone would refuse it)", async () => {
    const s = await open("drain");
    limits(1e12);
    const st = new WriteOrderState();
    const pa = s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 });
    s.runOrdered({ state: st, wseq: 2, wfloor: 1 }, () => s.setMetadata({ y: 2 }));
    expect(await code(pa)).toBe("ok");
    expect(s.getMetadata()).toEqual({ y: 2 });
    expect(sizes(s)).toEqual([6000]);
  });

  it("GAP (reconnect/resend): B arrives before A: blocked; A admitted; B's resend after it", async () => {
    const s = await open("gap");
    limits(1e12);
    const st = new WriteOrderState();
    expect(await code(s.setQueued(B(), { state: st, wseq: 2, wfloor: 1 }))).toBe("rate_limited");
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("ok");
    expect(await code(s.setQueued(B(), { state: st, wseq: 2, wfloor: 2 }))).toBe("ok");
    expect(sizes(s)).toEqual([6000, 100]);
  });

  it("LATE AFTER PRUNE: A refused; the client gives up (B carries floor 2) and B commits; then a late copy of A arrives: rejected, never applied", async () => {
    const s = await open("late");
    await spend(s);
    const st = new WriteOrderState();
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("rate_limited");
    limits(1e12);
    expect(await code(s.setQueued(B(), { state: st, wseq: 2, wfloor: 2 }))).toBe("ok");
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("write_stale");
    expect(() => s.runOrdered({ state: st, wseq: 1, wfloor: 1 }, () => s.setMetadata({ late: true }))).toThrow(
      expect.objectContaining({ code: "write_stale" }),
    );
    expect(sizes(s)).toEqual([4096, 100]);
    expect(s.getMetadata()).not.toEqual({ late: true });
    // an old, lower floor does not reopen it
    expect(await code(s.setQueued(B(), { state: st, wseq: 3, wfloor: 1 }))).toBe("ok");
    expect(await code(s.setQueued(A(), { state: st, wseq: 1, wfloor: 1 }))).toBe("write_stale");
  });

  it("another connection (its own state) is not blocked, and can't clear this one's fence", async () => {
    const s = await open("two");
    await spend(s);
    const st1 = new WriteOrderState();
    const st2 = new WriteOrderState();
    expect(await code(s.setQueued(A(), { state: st1, wseq: 1, wfloor: 1 }))).toBe("rate_limited");
    limits(1e12); // the refill: only the order can refuse now
    // connection 2 sends the same numbers, admitted on its own
    expect(await code(s.setQueued(B(), { state: st2, wseq: 1, wfloor: 1 }))).toBe("ok");
    expect(await code(s.setQueued(B(), { state: st2, wseq: 2, wfloor: 2 }))).toBe("ok");
    // connection 1's fence is still there
    expect(await code(s.setQueued(B(), { state: st1, wseq: 2, wfloor: 1 }))).toBe("rate_limited");
  });
});

describe("028 B-3a AS-B3-ORDER-1: the client", () => {
  const WRITE = new Set(["setMetadata", "set", "delete"]);
  let client: any;
  let sends: { wseq: number; wfloor: number; respond: (ok: boolean) => void }[];

  beforeAll(async () => {
    await before();
  });
  afterAll(async () => {
    setRateLimitedJitterForTests(undefined);
    setRateLimitedRetryMsForTests(60_000);
    await after();
  });
  beforeEach(() => {
    setRateLimitedJitterForTests(() => 0); // every pause: half the backoff
    client = persistClient({
      client: connect(),
      user: { hub_id: "x" },
      storage: { path: `hub/write-order-${Math.random()}` },
      noCache: true,
    });
    sends = [];
    const real = client.requestOnce;
    // the server, simulated: every write send is answered when the test says
    client.requestOnce = (data: any, opts: any) => {
      const h = opts?.headers ?? {};
      if (!WRITE.has(h.cmd)) return real(data, opts);
      return new Promise((resolve) =>
        sends.push({
          wseq: h.wseq,
          wfloor: h.wfloor,
          respond: (ok) =>
            resolve(ok ? { headers: {}, data: h.wseq } : { headers: { code: "rate_limited", error: "over budget" } }),
        }),
      );
    };
  });
  afterEach(() => {
    try {
      client.close();
    } catch {}
  });
  // (a failing test may leave writes pending: never an unhandled rejection)
  const write = () => {
    const p = client.request(null, { headers: { cmd: "setMetadata" } });
    p.catch(() => {});
    return p;
  };
  const floorsNonDecreasing = () => {
    const f = sends.map((x) => x.wfloor);
    expect(f).toEqual([...f].sort((a, b) => a - b));
  };

  it("wseq is reserved at ISSUE, before the first send; wfloor is the lowest unresolved", async () => {
    const all = [write(), write(), write()];
    await until(() => sends.length == 3);
    expect(sends.map((x) => [x.wseq, x.wfloor])).toEqual([[1, 1], [2, 1], [3, 1]]);
    sends[0].respond(true);
    sends[1].respond(true);
    sends[2].respond(true);
    expect(await Promise.all(all)).toHaveLength(3);
  });

  it("OUT-OF-ORDER refusals: B's refusal arrives first, then A's: A is resent first, and B only after A resolved", async () => {
    const done: number[] = [];
    const pA = write().then(() => done.push(1));
    const pB = write().then(() => done.push(2));
    await until(() => sends.length == 2);
    sends[1].respond(false); // B refused first
    sends[0].respond(false); // then A
    await until(() => sends.length == 3);
    expect(sends[2].wseq).toBe(1); // A's resend
    await new Promise((r) => setTimeout(r, 400)); // B's backoff is long over
    expect(sends.length).toBe(3); // B still waits for A
    sends[2].respond(true);
    await until(() => sends.length == 4);
    expect([sends[3].wseq, sends[3].wfloor]).toEqual([2, 2]);
    sends[3].respond(true);
    await Promise.all([pA, pB]);
    expect(done).toEqual([1, 2]);
    floorsNonDecreasing();
  });

  it("a NEW write issued behind a pending retry is not sent before the refused one is resolved", async () => {
    const pA = write();
    await until(() => sends.length == 1);
    sends[0].respond(false);
    await new Promise((r) => setTimeout(r, 20)); // A's refusal processed
    const pC = write(); // issued while A waits to be resent
    await until(() => sends.length == 2);
    expect(sends[1].wseq).toBe(1); // A's resend, not C
    await new Promise((r) => setTimeout(r, 300));
    expect(sends.length).toBe(2);
    sends[1].respond(true);
    await until(() => sends.length == 3);
    expect([sends[2].wseq, sends[2].wfloor]).toEqual([2, 2]);
    sends[2].respond(true);
    await Promise.all([pA, pC]);
    floorsNonDecreasing();
  });

  it("GIVE-UP: A refused until its window passes; then B goes, carrying a floor past A (the server drops A's fence and rejects a late A)", async () => {
    setRateLimitedRetryMsForTests(500);
    const pA = write();
    await until(() => sends.length == 1);
    sends[0].respond(false);
    await new Promise((r) => setTimeout(r, 20)); // A's refusal processed
    const pB = write(); // waits behind A
    // refuse every send of A until A gives up
    let answered = 1;
    while (true) {
      await until(() => sends.length > answered);
      const x = sends[answered++];
      if (x.wseq != 1) {
        expect(x.wfloor).toBe(2);
        x.respond(true);
        break;
      }
      x.respond(false);
    }
    await expect(pA).rejects.toMatchObject({ code: "rate_limited" });
    await pB;
    floorsNonDecreasing();
  });
});

describe("028 B-3a AS-B3-ORDER-1: server.ts keeps the order per connection", () => {
  it("one WriteOrderState per connection; every write path passes it on", () => {
    const src = fs.readFileSync(join(__dirname, "../../../../conat/persist/server.ts"), "utf8");
    expect(src).toMatch(/server\.on\("connection", \(socket: ServerSocket\) => \{[\s\S]{0,1200}const writeOrder = new WriteOrderState\(\);/);
    expect(src).toMatch(/const order = isWriteCommand\(request\)\s*\? parseWriteOrder\(request, writeOrder\)\s*: undefined;/);
    expect(src).toMatch(/\}, order\),/); // set
    expect(src).toMatch(/\),\s*order,\s*\),/); // setMany
    for (const call of ["delete(request)", "setMetadata(mesg.data)", "patchMetadata(mesg.data)", "resetHistory(mesg.data ?? {})", "purgeArchivedHistory()", "setCheckpoint(mesg.data)", "deleteCheckpoint(request.name)", "sqlite(request.statement, request.params)", "config(request.config)"]) {
      expect([call, src.includes(`ordered(() => stream!.${call})`)]).toEqual([call, true]);
    }
    expect(src).not.toMatch(/request\.writer/);
  });
});
