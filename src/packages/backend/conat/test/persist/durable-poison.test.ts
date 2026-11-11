/*
Finding 028, B-1: the whole-transaction abort, sync errors that poison a
file, and the records an open checks (DESIGN v1.16 §3, §3.2.2 A, §3.2.4-6,
§8).  Sync errors are injected here by making a statement on the stream's
connection throw SQLITE_IOERR_FSYNC (the error SQLite reports when fsync
fails); what that does to the file is what is tested.
*/

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  nodeDurabilityRecords,
  persistDurabilityRecords,
  persistRunDir,
} from "@cocalc/backend/conat/persist-durability";
import { DataEncoding } from "@cocalc/conat/core/client";
import {
  SQLITE_IOERR_FSYNC,
  openDiskStreamPaths,
  poisonedStreamPaths,
} from "@cocalc/conat/persist/storage";
import {
  guardStatements,
  UnguardedWriteError,
} from "@cocalc/conat/persist/test-durability";

const msg = (s: string, extra: object = {}) => ({
  encoding: DataEncoding.JsonCodec,
  raw: Buffer.from(s),
  ...extra,
});

function syncError(): Error {
  const err: any = new Error("disk I/O error");
  err.errcode = SQLITE_IOERR_FSYNC;
  err.code = "ERR_SQLITE_ERROR";
  return err;
}

function rowCount(stream): number {
  return Number(
    ((stream as any).db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any).n,
  );
}

describe("028 B-1: aborts, poison and the open check", () => {
  let dir: string;
  const records = persistDurabilityRecords();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-poison-"));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  describe("SQLite rolling back the whole transaction mid-batch (SA H1)", () => {
    // SQLite may roll back the WHOLE transaction on SQLITE_FULL (or IOERR,
    // BUSY, NOMEM): SA's probe shows it for a bare table; with the persist
    // schema SQLite rolls back just the statement (next test).  This one
    // makes the failing insert end the transaction, as SQLite does then.
    function failInsertLikeSqliteFull(stream, which: (raw: Buffer) => boolean) {
      const db = (stream as any).db;
      const prepare = db.prepare;
      db.prepare = (sql: string, ...rest) => {
        const stmt = prepare(sql, ...rest);
        if (sql.startsWith("INSERT INTO messages")) {
          const get = stmt.get.bind(stmt);
          stmt.get = (...args) => {
            if (which(args[3])) {
              db.exec("ROLLBACK");
              const err: any = new Error("database or disk is full");
              err.errcode = 13;
              err.code = "ERR_SQLITE_ERROR";
              throw err;
            }
            return get(...args);
          };
        }
        return stmt;
      };
    }

    it("aborts the batch: no row of any request, all fail, nothing emitted, nothing autocommitted", async () => {
      const stream = pstream({ path: join(dir, "full"), noCache: true });
      try {
        stream.set(msg("existing", { msgID: "m0" }));
        failInsertLikeSqliteFull(stream, (raw) => raw?.length > 1000);
        const changes: any[] = [];
        stream.on("change", (c) => changes.push(c));
        const lengthBefore = stream.length;
        const log: string[] = [];
        const db = (stream as any).db;
        const exec = db.exec;
        db.exec = (sql: string) => {
          log.push(sql);
          return exec(sql);
        };
        const r = await Promise.allSettled([
          stream.setQueued(msg("small-1", { msgID: "m1" })),
          stream.setQueued({
            encoding: DataEncoding.MsgPack,
            raw: randomBytes(4096),
            msgID: "m2",
          }),
          stream.setQueued(msg("small-3", { msgID: "m3" })),
        ]);
        expect(r.map((x) => x.status)).toEqual([
          "rejected",
          "rejected",
          "rejected",
        ]);
        // the failing request gets its own error, the others a retryable one
        expect((r[1] as any).reason?.errcode).toBe(13);
        expect((r[0] as any).reason?.code).toBe(503);
        expect((r[2] as any).reason?.code).toBe(503);
        expect(changes).toEqual([]);
        expect(db.isTransaction).toBe(false);
        // nothing more was applied, and no COMMIT was tried
        expect(log.filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(2);
        expect(log).not.toContain("COMMIT");
        // nothing of the batch is in the file; small-3 did not autocommit
        expect(rowCount(stream)).toBe(1);
        // in-memory = SQL: the count, and the msg ids (m1 is not deduped)
        expect(stream.length).toBe(lengthBefore);
        // no read ever returns a seq of the rolled-back batch (§4A; 061 D-4):
        // reads run only between batches, never inside one
        expect(stream.get({ seq: 2 })).toBeUndefined();
        expect(stream.seq()).toBe(1);
        const again = await stream.setQueued(msg("small-1", { msgID: "m1" }));
        // SQLite hands the rolled-back seq out again: never seen before, so
        // no client can have resumed past it
        expect(again.seq).toBe(2);
        expect(rowCount(stream)).toBe(2);
      } finally {
        stream.close();
      }
    });

    it("the same at an op inside a setMany", async () => {
      const stream = pstream({ path: join(dir, "full-op"), noCache: true });
      try {
        stream.set(msg("existing"));
        failInsertLikeSqliteFull(stream, (raw) => raw?.length > 1000);
        const many = stream.setManyQueued([
          msg("a"),
          { encoding: DataEncoding.MsgPack, raw: randomBytes(4096) },
          msg("c"),
        ]);
        const other = stream.setQueued(msg("other"));
        const r = await Promise.allSettled([many, other]);
        expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
        expect((stream as any).db.isTransaction).toBe(false);
        expect(rowCount(stream)).toBe(1);
        expect(stream.length).toBe(1);
      } finally {
        stream.close();
      }
    });

    it("a real SQLITE_FULL with the persist schema rolls back the statement only: just that request fails", async () => {
      const stream = pstream({ path: join(dir, "full-real"), noCache: true });
      try {
        stream.set(msg("existing"));
        const db = (stream as any).db;
        const pages = Number((db.prepare("PRAGMA page_count").get() as any).page_count);
        db.exec(`PRAGMA max_page_count=${pages + 2}`);
        const r = await Promise.allSettled([
          stream.setQueued(msg("small-1")),
          stream.setQueued({
            encoding: DataEncoding.MsgPack,
            raw: randomBytes(512 * 1024),
          }),
          stream.setQueued(msg("small-3")),
        ]);
        expect(r.map((x) => x.status)).toEqual([
          "fulfilled",
          "rejected",
          "fulfilled",
        ]);
        expect((r[1] as any).reason?.errcode).toBe(13);
        db.exec("PRAGMA max_page_count=1073741823");
        expect(rowCount(stream)).toBe(3);
        expect(stream.length).toBe(3);
      } finally {
        stream.close();
      }
    });
  });

  describe("a sync error poisons the file (§3.2.2 A, §3.2.4)", () => {
    it("at COMMIT: no ack, no emit, the queue fails, no read, no close, and no later open", async () => {
      const path = join(dir, "poison-commit");
      const stream = pstream({ path });
      const { seq } = await stream.setQueued(msg("a"));
      const db = (stream as any).db;
      const exec = db.exec;
      db.exec = (sql: string) => {
        if (sql == "COMMIT") throw syncError();
        return exec(sql);
      };
      const changes: any[] = [];
      stream.on("change", (c) => changes.push(c));
      const id = (stream as any).logicalId;
      // the dirty record exists before the failing COMMIT
      const p1 = stream.setQueued(msg("b"));
      const p2 = stream.setQueued(msg("c"));
      await expect(p1).rejects.toMatchObject({ code: 503 });
      await expect(p2).rejects.toMatchObject({ code: 503 });
      expect(changes).toEqual([]);
      expect(stream.isPoisoned()).toBe(true);
      // the record: renamed into the poisoned-file record
      expect(existsSync(records.poisonedPath(id))).toBe(true);
      expect(existsSync(records.dirtyPath(id))).toBe(false);
      // nothing more on the connection: no read, no write
      expect(() => stream.get({ seq })).toThrow(/sync error/);
      await expect(stream.setQueued(msg("d"))).rejects.toMatchObject({
        code: 503,
      });
      // never closed (a close checkpoints): close is a no-op, the connection
      // stays open and referenced, and counts as open for the fence
      stream.close();
      expect(db.isOpen).toBe(true);
      expect(poisonedStreamPaths()).toContain(path);
      expect(openDiskStreamPaths()).toContain(path);
      // no later open in this process, nor in another process of this boot
      expect(() => pstream({ path })).toThrow(/sync error/);
      expect(nodeDurabilityRecords(persistRunDir(), "another-process").check(id)).toBe(
        "poisoned",
      );
    });

    it("at a statement inside the batch (a cache spill's WAL sync, V-1): the record already existed; nothing commits", async () => {
      const stream = pstream({ path: join(dir, "poison-spill") });
      const id = (stream as any).logicalId;
      const db = (stream as any).db;
      const prepare = db.prepare;
      let armedAtFailure: boolean | undefined;
      db.prepare = (sql: string, ...rest) => {
        const stmt = prepare(sql, ...rest);
        if (sql.startsWith("INSERT INTO messages")) {
          stmt.get = () => {
            armedAtFailure = existsSync(records.dirtyPath(id));
            throw syncError();
          };
        }
        return stmt;
      };
      await expect(stream.setQueued(msg("a"))).rejects.toMatchObject({
        code: 503,
      });
      expect(armedAtFailure).toBe(true);
      expect(stream.isPoisoned()).toBe(true);
      expect(existsSync(records.poisonedPath(id))).toBe(true);
    });

    it("in another write's own transaction", () => {
      const stream = pstream({ path: join(dir, "poison-metadata") });
      const db = (stream as any).db;
      const exec = db.exec;
      db.exec = (sql: string) => {
        if (sql == "COMMIT") throw syncError();
        return exec(sql);
      };
      expect(() => stream.setMetadata({ a: 1 })).toThrow();
      expect(stream.isPoisoned()).toBe(true);
    });

    it("in close's checkpoint: the database is NOT closed, and the file is poisoned", async () => {
      const path = join(dir, "poison-close");
      const stream = pstream({ path });
      await stream.setQueued(msg("a"));
      const db = (stream as any).db;
      const prepare = db.prepare;
      db.prepare = (sql: string, ...rest) => {
        const stmt = prepare(sql, ...rest);
        if (sql.includes("wal_checkpoint(FULL)")) {
          stmt.get = () => {
            throw syncError();
          };
        }
        return stmt;
      };
      stream.close();
      expect(stream.isPoisoned()).toBe(true);
      expect(db.isOpen).toBe(true);
      expect(existsSync(`${path}.db-wal`)).toBe(true);
      expect(() => pstream({ path })).toThrow(/sync error/);
    });

    it("a non-sync error is an op error: no poison", async () => {
      const stream = pstream({ path: join(dir, "not-poison"), noCache: true });
      try {
        const { seq } = stream.set(msg("v", { key: "k" }));
        await expect(
          stream.setQueued(msg("w", { key: "k", previousSeq: seq + 1 })),
        ).rejects.toThrow("wrong last sequence");
        expect(stream.isPoisoned()).toBe(false);
      } finally {
        stream.close();
      }
    });
  });

  describe("the open check (§3.2.5-6)", () => {
    it("refuses a stream another process left mid-write (its dirty record): not verified", () => {
      const path = join(dir, "left-dirty");
      const other = nodeDurabilityRecords(persistRunDir(), "crashed-process");
      other.arm(path);
      expect(() => pstream({ path })).toThrow(/not verified/);
      // and no file was created or read
      expect(existsSync(`${path}.db`)).toBe(false);
      other.disarm(path);
      const stream = pstream({ path });
      stream.close();
    });

    it("opens a stream whose dirty record is this process's own (no sync error was seen)", () => {
      const path = join(dir, "own-dirty");
      records.arm(path);
      const stream = pstream({ path });
      stream.close();
      expect(existsSync(records.dirtyPath(path))).toBe(false);
    });

    it("journal_mode is armed at every open: a new file, and a legacy file not in WAL mode", () => {
      // the statement guard (test setup) refuses an unarmed journal_mode
      // switch, so these opens prove the arm
      const path = join(dir, "legacy");
      pstream({ path, noCache: true }).close();
      const raw = new DatabaseSync(`${path}.db`);
      raw.exec("PRAGMA journal_mode=DELETE");
      raw.close();
      const stream = pstream({ path, noCache: true });
      try {
        expect(
          ((stream as any).db.prepare("PRAGMA journal_mode").get() as any)
            .journal_mode,
        ).toBe("wal");
      } finally {
        stream.close();
      }
    });
  });

  describe("the statement guard (test-only)", () => {
    it("refuses a write outside a transaction, and an unarmed checkpoint or journal_mode switch", () => {
      const db = new DatabaseSync(join(dir, "guard.db"));
      let armed = false;
      const guarded = guardStatements(db, () => armed);
      try {
        guarded.exec("PRAGMA busy_timeout=500");
        expect(() => guarded.exec("CREATE TABLE t(a)")).toThrow(
          UnguardedWriteError,
        );
        guarded.exec("BEGIN");
        guarded.exec("CREATE TABLE t(a)");
        guarded.prepare("INSERT INTO t VALUES (1)").run();
        guarded.exec("COMMIT");
        expect(() => guarded.prepare("INSERT INTO t VALUES (2)").run()).toThrow(
          UnguardedWriteError,
        );
        expect(() =>
          guarded.prepare("PRAGMA wal_checkpoint(PASSIVE)").get(),
        ).toThrow(UnguardedWriteError);
        expect(() => guarded.exec("PRAGMA journal_mode=WAL")).toThrow(
          UnguardedWriteError,
        );
        armed = true;
        guarded.exec("PRAGMA journal_mode=WAL");
        guarded.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
        // reads are never refused
        expect(guarded.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({
          n: 1,
        });
      } finally {
        db.close();
      }
    });
  });
});
