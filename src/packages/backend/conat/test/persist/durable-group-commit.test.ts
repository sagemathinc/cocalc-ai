/*
Finding 028, B-1: durable writes with group commit (DESIGN v1.16 §3, §4, §8).

Disk-backed streams run with synchronous=FULL; set/setMany requests queued
for a stream commit together in one transaction, each in its own SAVEPOINT
(each op of a setMany in a nested one), and are acked and emitted only after
the COMMIT returned OK.  These tests run under the statement guard (test
setup): a write outside a transaction would throw.
*/

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { pstream } from "@cocalc/backend/conat/persist";
import { DataEncoding } from "@cocalc/conat/core/client";
import { getPersistWriteStats } from "@cocalc/backend/conat/persist-write-rate";
import {
  CHECKPOINT_WAL_PAGES,
  WRITE_BATCH_MAX_REQUESTS,
  getPersistentStreamDiagnostics,
} from "@cocalc/conat/persist/storage";

const msg = (s: string, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
  ...extra,
});

function delta(before: Record<string, number>, key: string): number {
  return getPersistWriteStats()[key] - before[key];
}

// the statements run on a stream's connection, in order (outermost spy)
function trace(stream) {
  const db = (stream as any).db;
  const log: string[] = [];
  const exec = db.exec;
  const prepare = db.prepare;
  db.exec = (sql: string) => {
    log.push(sql);
    return exec(sql);
  };
  db.prepare = (sql: string, ...rest) => {
    const stmt = prepare(sql, ...rest);
    for (const m of ["run", "get", "all", "iterate"]) {
      if (typeof stmt[m] != "function") continue;
      const f = stmt[m].bind(stmt);
      stmt[m] = (...args) => {
        log.push(sql);
        return f(...args);
      };
    }
    return stmt;
  };
  return log;
}

function rowCount(stream): number {
  return Number(
    ((stream as any).db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any).n,
  );
}

describe("028 B-1: durable group commit", () => {
  let dir: string;
  let streams: any[] = [];
  const open = (name: string, opts: object = {}) => {
    const s = pstream({ path: join(dir, name), ...opts });
    streams.push(s);
    return s;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-b1-"));
    streams = [];
  });

  afterEach(async () => {
    for (const s of streams) {
      try {
        if (!s.isPoisoned?.()) s.close();
      } catch {}
    }
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("disk streams run with synchronous=FULL and no auto-checkpoint; ephemeral ones are unchanged", () => {
    const disk = open("pragmas");
    const db = (disk as any).db;
    expect((db.prepare("PRAGMA synchronous").get() as any).synchronous).toBe(2);
    expect(
      (db.prepare("PRAGMA wal_autocheckpoint").get() as any).wal_autocheckpoint,
    ).toBe(0);
    expect((db.prepare("PRAGMA journal_mode").get() as any).journal_mode).toBe(
      "wal",
    );
    const eph = open("pragmas-eph", { ephemeral: true });
    expect(
      ((eph as any).db.prepare("PRAGMA wal_autocheckpoint").get() as any)
        .wal_autocheckpoint,
    ).toBe(1000);
  });

  it("commits the requests of one I/O phase in ONE transaction, then acks and emits them in arrival order", async () => {
    const stream = open("batch");
    const log = trace(stream);
    const order: string[] = [];
    stream.on("change", (change) => {
      // never inside the transaction that made it
      expect((stream as any).db.isTransaction).toBe(false);
      order.push(`emit ${change.seq}`);
    });
    const before = getPersistWriteStats();
    const acks = [1, 2, 3].map((i) =>
      stream.setQueued(msg(`${i}`)).then((r) => {
        order.push(`ack ${r.seq}`);
        return r;
      }),
    );
    const results = await Promise.all(acks);
    expect(results.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(delta(before, "disk_txn_commits_total")).toBe(1);
    expect(delta(before, "disk_autocommits_total")).toBe(0);
    expect(log.filter((s) => s == "BEGIN")).toHaveLength(1);
    expect(log.filter((s) => s == "COMMIT")).toHaveLength(1);
    // the changes are emitted after the COMMIT, in arrival order; the acks
    // (promise callbacks) after that
    expect(order).toEqual(["emit 1", "emit 2", "emit 3", "ack 1", "ack 2", "ack 3"]);
  });

  it("a single request on an idle stream adds no timer delay (W = 0)", async () => {
    const stream = open("w0");
    const start = Date.now();
    await stream.setQueued(msg("x"));
    expect(Date.now() - start).toBeLessThan(200);
  });

  it("a batch takes at most WRITE_BATCH_MAX_REQUESTS requests; the rest commit in the next one", async () => {
    const stream = open("cap");
    const before = getPersistWriteStats();
    const n = WRITE_BATCH_MAX_REQUESTS + 25;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => stream.setQueued(msg(`${i}`))),
    );
    expect(results).toHaveLength(n);
    expect(delta(before, "disk_txn_commits_total")).toBe(2);
    expect(rowCount(stream)).toBe(n);
  });

  it("a batch takes at most 4 MiB; the rest commit in the next one", async () => {
    const stream = open("cap-bytes");
    const before = getPersistWriteStats();
    // incompressible, so the size is what is stored
    const big = () => ({
      encoding: DataEncoding.MsgPack,
      raw: randomBytes(3 * 1024 * 1024),
    });
    await Promise.all([stream.setQueued(big()), stream.setQueued(big())]);
    expect(delta(before, "disk_txn_commits_total")).toBe(2);
  });

  it("a failing request gets its own error; the others of its batch commit, ack and emit", async () => {
    const stream = open("isolation");
    const { seq } = stream.set(msg("v0", { key: "k" }));
    const emitted: number[] = [];
    stream.on("change", (c) => c.seq != null && emitted.push(c.seq));
    const a = stream.setQueued(msg("a"));
    const bad = stream.setQueued(msg("v1", { key: "k", previousSeq: seq + 100 }));
    const c = stream.setQueued(msg("c"));
    await expect(bad).rejects.toThrow("wrong last sequence");
    const [ra, rc] = await Promise.all([a, c]);
    expect(emitted).toEqual([ra.seq, rc.seq]);
    expect(rowCount(stream)).toBe(3);
    // the stored count follows (in-memory = SQL)
    expect(stream.length).toBe(rowCount(stream));
  });

  it("a setMany op that fails after its limit deletes leaves no delete and emits none; its other ops commit", async () => {
    const stream = open("setmany-op");
    stream.config({ max_msgs: 2, max_msg_size: 10 });
    const first = stream.set(msg("1"));
    stream.set(msg("2"));
    const changes: any[] = [];
    stream.on("change", (c) => changes.push(c));
    // the second op is over max_msg_size: enforceLimits first deletes the
    // oldest message to make room, then throws
    const results = await stream.setManyQueued([
      msg("3"),
      msg("x".repeat(50)),
    ]);
    expect((results[0] as any).seq).toBeGreaterThan(0);
    expect((results[1] as any).error).toContain("max_msg_size");
    // only op 1's own room-making delete (of seq 1) happened; op 2's was
    // rolled back with it
    const seqs = (
      (stream as any).db.prepare("SELECT seq FROM messages ORDER BY seq").all() as any[]
    ).map((r) => r.seq);
    expect(seqs).toEqual([2, (results[0] as any).seq]);
    expect(seqs).not.toContain(first.seq);
    const deletes = changes.filter((c) => c.op == "delete");
    expect(deletes.flatMap((c) => c.seqs)).toEqual([first.seq]);
    expect(stream.length).toBe(rowCount(stream));
  });

  it("a batch in which nothing succeeds issues no COMMIT (no sync)", async () => {
    const stream = open("no-commit");
    const { seq } = stream.set(msg("v0", { key: "k" }));
    const log = trace(stream);
    const before = getPersistWriteStats();
    const r = await Promise.allSettled([
      stream.setQueued(msg("x", { key: "k", previousSeq: seq + 1 })),
      stream.setQueued(msg("y", { key: "k", previousSeq: seq + 2 })),
    ]);
    expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
    expect(log).not.toContain("COMMIT");
    expect(delta(before, "disk_commits_total")).toBe(0);
  });

  it("another mutation commits what is queued first: arrival order across set → setMetadata → set", async () => {
    const stream = open("order");
    const log = trace(stream);
    const a = stream.setQueued(msg("a"));
    stream.setMetadata({ m: 1 });
    const b = stream.setQueued(msg("b"));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.seq).toBeLessThan(rb.seq);
    const commits = log
      .map((s, i) => (s == "COMMIT" ? i : -1))
      .filter((i) => i >= 0);
    expect(commits).toHaveLength(3);
    const metadataWrite = log.findIndex((s) => s.includes("stream_metadata"));
    // a's batch committed before the metadata transaction began
    expect(commits[0]).toBeLessThan(metadataWrite);
  });

  it("duplicate msgIDs: one row and one change, within a batch, within a setMany, and of a committed one", async () => {
    const stream = open("dups");
    const changes: any[] = [];
    stream.on("change", (c) => changes.push(c));
    const [r1, r2] = await Promise.all([
      stream.setQueued(msg("a", { msgID: "m1" })),
      stream.setQueued(msg("a", { msgID: "m1" })),
    ]);
    expect(r2).toEqual(r1);
    const many = await stream.setManyQueued([
      msg("b", { msgID: "m2" }),
      msg("b", { msgID: "m2" }),
    ]);
    expect(many[1]).toEqual(many[0]);
    const again = await stream.setQueued(msg("a", { msgID: "m1" }));
    expect(again).toEqual(r1);
    expect(rowCount(stream)).toBe(2);
    expect(changes.filter((c) => c.seq != null)).toHaveLength(2);
  });

  it("a resend of a stored msgID after close and reopen returns the original seq and inserts nothing", async () => {
    const path = join(dir, "resend");
    const s1 = pstream({ path });
    const { seq, time } = await s1.setQueued(msg("a", { msgID: "lost-ack" }));
    s1.close();
    const s2 = pstream({ path });
    streams.push(s2);
    const again = await s2.setQueued(msg("a", { msgID: "lost-ack" }));
    expect(again.seq).toBe(seq);
    expect(Math.abs(again.time - time)).toBeLessThan(2);
    expect(rowCount(s2)).toBe(1);
  });

  it("a read sees committed state only: queued requests are not visible until acked", async () => {
    const stream = open("reads");
    const pending = stream.setQueued(msg("a"));
    expect(stream.get({ seq: 1 })).toBeUndefined();
    expect(rowCount(stream)).toBe(0);
    const { seq } = await pending;
    expect(stream.get({ seq })?.seq).toBe(seq);
  });

  it("config with several keys and its limit deletes is ONE commit", () => {
    const stream = open("config-one");
    stream.setMany([msg("1"), msg("2"), msg("3")]);
    const before = getPersistWriteStats();
    stream.config({ max_msgs: 1, max_age: 10_000_000, desc: "d" } as any);
    expect(delta(before, "disk_commits_total")).toBe(1);
    expect(delta(before, "disk_autocommits_total")).toBe(0);
    expect(stream.length).toBe(1);
  });

  it("every write transaction is armed BEFORE its BEGIN, and the record is removed at the next write idle", async () => {
    const stream = open("arm");
    const records = require("@cocalc/backend/conat/persist-durability").persistDurabilityRecords();
    const dirty = records.dirtyPath((stream as any).logicalId);
    expect(existsSync(dirty)).toBe(false);
    const db = (stream as any).db;
    const exec = db.exec;
    const seenAtBegin: boolean[] = [];
    db.exec = (sql: string) => {
      if (sql == "BEGIN") seenAtBegin.push(existsSync(dirty));
      return exec(sql);
    };
    await stream.setQueued(msg("a")); // the group-commit flush
    stream.setMetadata({ a: 1 }); // another write's own transaction
    stream.deleteCheckpoint("none");
    stream.config({ max_msgs: 5 });
    expect(seenAtBegin).toEqual([true, true, true, true]);
    // idle again: removed
    expect(existsSync(dirty)).toBe(false);
  });

  it("if the dirty record can't be created, no BEGIN runs and the write fails retryably", async () => {
    const stream = open("arm-fail");
    const records = require("@cocalc/backend/conat/persist-durability").persistDurabilityRecords();
    const log = trace(stream);
    const arm = jest.spyOn(records, "arm").mockImplementation(() => {
      throw Error("tmpfs full");
    });
    await expect(stream.setQueued(msg("a"))).rejects.toMatchObject({
      code: 503,
    });
    expect(() => stream.setMetadata({ x: 1 })).toThrow(/durability record/);
    expect(log).not.toContain("BEGIN");
    arm.mockRestore();
    expect((await stream.setQueued(msg("b"))).seq).toBe(1);
  });

  it("runs an explicit, checked PASSIVE checkpoint between batches once the WAL is large", async () => {
    const stream = open("checkpoint");
    const log = trace(stream);
    const big = () => ({
      encoding: DataEncoding.MsgPack,
      raw: randomBytes(1024 * 1024),
    });
    for (let i = 0; i < 6 && !log.some((s) => s.includes("wal_checkpoint")); i++) {
      await stream.setQueued(big());
    }
    expect(log).toContain("PRAGMA wal_checkpoint(PASSIVE)");
    expect(CHECKPOINT_WAL_PAGES).toBe(1000);
  });

  it("close runs a checked FULL checkpoint, armed, and then removes the dirty record", async () => {
    const stream = open("close");
    await stream.setQueued(msg("a"));
    const records = require("@cocalc/backend/conat/persist-durability").persistDurabilityRecords();
    const dirty = records.dirtyPath((stream as any).logicalId);
    const db = (stream as any).db;
    const prepare = db.prepare;
    let armedAtCheckpoint: boolean | undefined;
    db.prepare = (sql: string, ...rest) => {
      if (sql.includes("wal_checkpoint(FULL)")) armedAtCheckpoint = existsSync(dirty);
      return prepare(sql, ...rest);
    };
    stream.close();
    streams = streams.filter((s) => s !== stream);
    expect(armedAtCheckpoint).toBe(true);
    expect(existsSync(dirty)).toBe(false);
  });

  it("a close reached with requests still queued fails them retryably and closes normally", async () => {
    const stream = pstream({ path: join(dir, "close-queued"), noCache: true });
    const before = getPersistentStreamDiagnostics().closed_with_queued_writes_total;
    const pending = stream.setQueued(msg("a"));
    expect(() => stream.close()).not.toThrow();
    await expect(pending).rejects.toMatchObject({ code: 503 });
    expect(getPersistentStreamDiagnostics().closed_with_queued_writes_total).toBe(
      before + 1,
    );
    // nothing of it was committed
    const again = pstream({ path: join(dir, "close-queued"), noCache: true });
    try {
      expect(again.length).toBe(0);
    } finally {
      again.close();
    }
  });

  it("closeDurably commits what is queued before it closes", async () => {
    const { closeDurably } = require("@cocalc/backend/conat/persist");
    const path = join(dir, "close-durably");
    const stream = pstream({ path, noCache: true });
    const pending = stream.setQueued(msg("a"));
    closeDurably(stream);
    expect((await pending).seq).toBe(1);
    const again = pstream({ path, noCache: true });
    try {
      expect(again.length).toBe(1);
    } finally {
      again.close();
    }
  });

  it("the emit helper is the only place a change is emitted", () => {
    const source = readFileSync(
      join(__dirname, "../../../../conat/persist/storage.ts"),
      "utf8",
    );
    const emits = [...source.matchAll(/this\.emit\("change"/g)];
    expect(emits).toHaveLength(1);
    const helper = source.indexOf("private emitChange = ");
    expect(helper).toBeGreaterThan(0);
    expect(emits[0].index! - helper).toBeLessThan(300);
  });

  // review of #139 (security-audit, B1-1..B1-4)

  it("B1-1: after a large checkpoint, small batches run no checkpoint until the WAL is large again", async () => {
    const stream = open("ckpt-once");
    const log = trace(stream);
    await stream.setQueued({
      encoding: DataEncoding.MsgPack,
      raw: randomBytes(5 * 1024 * 1024),
    });
    expect(log.filter((s) => s.includes("wal_checkpoint"))).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      await stream.setQueued(msg(`small ${i}`));
    }
    expect(log.filter((s) => s.includes("wal_checkpoint"))).toHaveLength(1);
  });

  it("B1-2: a config change that rolls back leaves the committed config in effect", () => {
    const stream = open("config-rollback");
    stream.setMany([msg("1"), msg("2"), msg("3")]);
    const db = (stream as any).db;
    const prepare = db.prepare;
    db.prepare = (sql: string, ...rest) => {
      const stmt = prepare(sql, ...rest);
      if (sql.includes("ORDER BY seq ASC LIMIT ?")) {
        stmt.all = () => {
          throw Error("injected failure in the limit delete");
        };
      }
      return stmt;
    };
    expect(() => stream.config({ max_msgs: 1 })).toThrow("injected");
    db.prepare = prepare;
    expect((stream as any).conf.max_msgs).toBe(-1);
    expect(stream.config().max_msgs).toBe(-1);
    expect(stream.length).toBe(3);
  });

  it("B1-3: a second connection to the same file never removes the dirty record the first still needs", async () => {
    const path = join(dir, "two-connections");
    const a = pstream({ path, noCache: true });
    const b = pstream({ path, noCache: true });
    try {
      const records = require("@cocalc/backend/conat/persist-durability").persistDurabilityRecords();
      const dirty = records.dirtyPath(a.logicalId);
      const db = (a as any).db;
      const exec = db.exec;
      const armedAtBegin: boolean[] = [];
      db.exec = (sql: string) => {
        if (sql == "BEGIN") armedAtBegin.push(existsSync(dirty));
        return exec(sql);
      };
      const n = WRITE_BATCH_MAX_REQUESTS + 10;
      const all = Promise.all(
        Array.from({ length: n }, (_, i) => a.setQueued(msg(`a${i}`))),
      );
      // after a's first batch (500), before its second: b writes and idles
      setImmediate(() => b.set(msg("b")));
      await all;
      expect(armedAtBegin).toEqual([true, true]);
      expect(existsSync(dirty)).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });

  it("B1-3: a sync error on one connection poisons every connection of this process to the file", async () => {
    const path = join(dir, "two-poison");
    const a = pstream({ path, noCache: true });
    const b = pstream({ path, noCache: true });
    const db = (a as any).db;
    const exec = db.exec;
    db.exec = (sql: string) => {
      if (sql == "COMMIT") {
        const err: any = new Error("disk I/O error");
        err.errcode = 1034;
        throw err;
      }
      return exec(sql);
    };
    await expect(a.setQueued(msg("x"))).rejects.toMatchObject({ code: 503 });
    expect(a.isPoisoned()).toBe(true);
    expect(b.isPoisoned()).toBe(true);
    expect(() => b.get({ seq: 1 })).toThrow(/sync error/);
  });

  it("B1-4: a change listener that writes synchronously gets its result, and its write is stored once", async () => {
    const stream = open("listener-writes");
    const results: any[] = [];
    let once = false;
    stream.on("change", (c) => {
      if (once || c.seq == null) return;
      once = true;
      results.push(stream.set(msg("from listener")));
    });
    const r = await stream.setQueued(msg("first"));
    expect(results).toHaveLength(1);
    expect(results[0].seq).toBe(r.seq + 1);
    expect(rowCount(stream)).toBe(2);
  });

  it("a write batch is synchronous from BEGIN to COMMIT: no await, so no read interleaves (061 D-4)", () => {
    const source = readFileSync(
      join(__dirname, "../../../../conat/persist/storage.ts"),
      "utf8",
    );
    for (const fn of ["private flushWriteBatch = ", "private commitWriteBatch = ", "private abortWriteBatch = "]) {
      const start = source.indexOf(fn);
      expect(start).toBeGreaterThan(0);
      const end = source.indexOf("\n  };\n", start);
      const body = source.slice(start, end);
      expect(body).not.toMatch(/\bawait\b|\basync\b|\.then\(/);
    }
  });
});
