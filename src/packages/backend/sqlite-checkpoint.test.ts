/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  deferWalCheckpoints,
  forgetWalCheckpoints,
  liveWalBytes,
  runCheckpointPass,
  setCheckpointIntervalForTests,
  setCheckpointWorkerEnabledForTests,
  walCheckpointStatus,
  walStatus,
} from "./sqlite-checkpoint";

let dir: string;

function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v BLOB)");
  return db;
}

function autocheckpoint(db: DatabaseSync): number {
  return Number(
    (db.prepare("PRAGMA wal_autocheckpoint").get() as any).wal_autocheckpoint,
  );
}

// Enough WAL pages to cross SQLite's default 1000-page autocheckpoint.
function writeMany(db: DatabaseSync, rows = 1500): void {
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
  for (let i = 0; i < rows; i++) {
    insert.run(Buffer.alloc(4096, i % 256));
  }
}

async function eventually(fn: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sqlite-checkpoint-"));
  setCheckpointWorkerEnabledForTests(true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("deferWalCheckpoints", () => {
  it("stops inline checkpoints and lets the worker checkpoint", async () => {
    const file = join(dir, "a.db");
    const db = openDb(file);
    expect(deferWalCheckpoints(db, file, { enableInTests: true })).toBe(true);
    expect(autocheckpoint(db)).toBe(0);

    writeMany(db);
    // No commit checkpointed inline, so the WAL holds every page.
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(1000 * 4096);

    await runCheckpointPass();
    await eventually(() => walCheckpointStatus(file)?.lastResult != null);
    const result = walCheckpointStatus(file)!.lastResult!;
    expect(result.error).toBeUndefined();
    expect(result.log).toBeGreaterThan(1000);
    // A passive checkpoint with no reader in the way copies every frame.
    expect(result.checkpointed).toBe(result.log);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({
      n: 1500,
    });

    forgetWalCheckpoints(file);
    db.close();
  }, 30_000);

  it("checkpoints inline again while the worker is not keeping up", async () => {
    const file = join(dir, "b.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
    });
    setCheckpointWorkerEnabledForTests(false);
    writeMany(db, 100);

    // Recently registered: not yet considered stale.
    await runCheckpointPass();
    expect(walCheckpointStatus(file)!.inlineFallback).toBe(false);
    expect(autocheckpoint(db)).toBe(0);

    // Long without a successful worker checkpoint, and the WAL is over the cap.
    await runCheckpointPass(Date.now() + 60_000);
    expect(walCheckpointStatus(file)!.inlineFallback).toBe(true);
    expect(autocheckpoint(db)).toBe(1000);

    // The worker recovers: back to deferred checkpoints.
    setCheckpointWorkerEnabledForTests(true);
    await runCheckpointPass();
    await eventually(() => walCheckpointStatus(file)!.inlineFallback === false);
    expect(autocheckpoint(db)).toBe(0);

    forgetWalCheckpoints(file);
    db.close();
  }, 30_000);

  it("does not count a partial checkpoint as success", async () => {
    const file = join(dir, "pinned.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
    });
    writeMany(db, 50);
    // A reader holding an old snapshot keeps the newer frames in the WAL.
    const reader = new DatabaseSync(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM t").get();
    writeMany(db, 200);

    const registeredAt = walCheckpointStatus(file)!.lastSuccessAt;
    await runCheckpointPass();
    await eventually(() => walCheckpointStatus(file)?.lastResult != null);
    const partial = walCheckpointStatus(file)!;
    expect(partial.lastResult!.error).toBeUndefined();
    expect(partial.lastResult!.checkpointed!).toBeLessThan(
      partial.lastResult!.log!,
    );
    expect(partial.lastSuccessAt).toBe(registeredAt);
    expect(partial.incompleteSince).toEqual(expect.any(Number));

    // So a stale, over-cap WAL still falls back to inline checkpoints.
    await runCheckpointPass(Date.now() + 60_000);
    await eventually(() => walCheckpointStatus(file)!.inlineFallback);
    expect(autocheckpoint(db)).toBe(1000);

    // Once the reader lets go, a complete checkpoint ends the fallback.
    reader.exec("COMMIT");
    reader.close();
    await runCheckpointPass();
    await eventually(() => walCheckpointStatus(file)!.inlineFallback === false);
    expect(walCheckpointStatus(file)!.incompleteSince).toBeUndefined();
    expect(autocheckpoint(db)).toBe(0);
    forgetWalCheckpoints(file, db);
    db.close();
  }, 30_000);

  it("still falls back when the worker cannot be created", async () => {
    const file = join(dir, "noworker.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
    });
    writeMany(db, 100);
    setCheckpointWorkerEnabledForTests("throws");
    await expect(
      runCheckpointPass(Date.now() + 60_000),
    ).resolves.toBeUndefined();
    expect(walCheckpointStatus(file)!.inlineFallback).toBe(true);
    expect(autocheckpoint(db)).toBe(1000);
    setCheckpointWorkerEnabledForTests(true);
    forgetWalCheckpoints(file, db);
    db.close();
  });

  it("leaves a small WAL alone even when the worker is stale", async () => {
    const file = join(dir, "c.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, { enableInTests: true });
    setCheckpointWorkerEnabledForTests(false);
    writeMany(db, 10);
    await runCheckpointPass(Date.now() + 60_000);
    expect(walCheckpointStatus(file)!.inlineFallback).toBe(false);
    expect(autocheckpoint(db)).toBe(0);
    forgetWalCheckpoints(file);
    db.close();
  });

  it("does nothing for in-memory databases, in tests by default, or when disabled", () => {
    const mem = new DatabaseSync(":memory:");
    expect(deferWalCheckpoints(mem, ":memory:", { enableInTests: true })).toBe(
      false,
    );
    const file = join(dir, "d.db");
    const db = openDb(file);
    expect(deferWalCheckpoints(db, file)).toBe(false);
    expect(autocheckpoint(db)).toBe(1000);
    process.env.COCALC_SQLITE_INLINE_CHECKPOINTS = "1";
    try {
      expect(deferWalCheckpoints(db, file, { enableInTests: true })).toBe(
        false,
      );
    } finally {
      delete process.env.COCALC_SQLITE_INLINE_CHECKPOINTS;
    }
    expect(walCheckpointStatus(file)).toBeUndefined();
    db.close();
    mem.close();
  });

  it("tracks every connection to the same file", async () => {
    // e.g. the lite hub database and the quota queue sharing sqlite.db.
    const file = join(dir, "shared.db");
    const a = openDb(file);
    const b = openDb(file);
    deferWalCheckpoints(a, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
    });
    deferWalCheckpoints(b, file, { enableInTests: true });
    expect(walCheckpointStatus(file)!.connections).toBe(2);
    expect(autocheckpoint(a)).toBe(0);
    expect(autocheckpoint(b)).toBe(0);

    // The fallback applies to both connections, using the smaller cap.
    setCheckpointWorkerEnabledForTests(false);
    writeMany(a, 100);
    await runCheckpointPass(Date.now() + 60_000);
    expect(autocheckpoint(a)).toBe(1000);
    expect(autocheckpoint(b)).toBe(1000);

    // A connection opened while in fallback joins it.
    const c = openDb(file);
    deferWalCheckpoints(c, file, { enableInTests: true });
    expect(autocheckpoint(c)).toBe(1000);

    setCheckpointWorkerEnabledForTests(true);
    await runCheckpointPass();
    await eventually(() => walCheckpointStatus(file)!.inlineFallback === false);
    for (const db of [a, b, c]) expect(autocheckpoint(db)).toBe(0);

    // Closing one connection keeps the others registered.
    forgetWalCheckpoints(file, a);
    a.close();
    expect(walCheckpointStatus(file)!.connections).toBe(2);
    forgetWalCheckpoints(file, b);
    b.close();
    forgetWalCheckpoints(file, c);
    c.close();
    expect(walCheckpointStatus(file)).toBeUndefined();
  }, 30_000);

  // Projects, 2026-10-28: the runtime creates its database as root and then
  // runs as the project user, so the worker's new connection is read-only.
  // It logged "attempt to write a readonly database" every 5 s in every
  // project, flooding the host journal.
  (process.getuid?.() === 0 ? it.skip : it)(
    "gives checkpoints back to a database the worker cannot write",
    async () => {
      const file = join(dir, "readonly.db");
      const db = openDb(file);
      expect(deferWalCheckpoints(db, file, { enableInTests: true })).toBe(true);
      expect(autocheckpoint(db)).toBe(0);
      // This connection was opened while the files were writable; a new one
      // (the worker's) can only read them.
      for (const suffix of ["", "-wal", "-shm"]) {
        await chmod(`${file}${suffix}`, 0o444);
      }
      await runCheckpointPass();
      await eventually(() => walCheckpointStatus(file) == null);
      // Inline checkpoints again, as SQLite does by default, and the file
      // stays that way: later connections do not defer either.
      expect(autocheckpoint(db)).toBe(1000);
      const again = openDb(file);
      expect(deferWalCheckpoints(again, file, { enableInTests: true })).toBe(
        false,
      );
      // The original connection still writes and checkpoints.
      writeMany(db, 10);
      expect(
        (db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as any).busy,
      ).toBe(0);
      again.close();
      db.close();
    },
    30_000,
  );

  it("forgets a connection before it closes", () => {
    const file = join(dir, "e.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, { enableInTests: true });
    expect(walCheckpointStatus(file)).toBeDefined();
    forgetWalCheckpoints(file);
    expect(walCheckpointStatus(file)).toBeUndefined();
    db.close();
  });
});

// A WAL file keeps the size of the largest WAL it ever held: after a
// complete checkpoint SQLite reuses it from the start. On a host this left a
// 9.9 GB file around a 1.5 MB live WAL, and the fallback (which looked at
// the file) put checkpoints back on the event loop again and again.
describe("the live WAL, not the file", () => {
  afterEach(() => setCheckpointIntervalForTests(5_000));

  // A database whose WAL file is large but whose live WAL is a few frames,
  // with a reader holding a snapshot so that no checkpoint completes.
  function staleHighWater(name: string): {
    file: string;
    db: DatabaseSync;
    reader: DatabaseSync;
  } {
    const file = join(dir, name);
    const db = openDb(file);
    db.exec("PRAGMA wal_autocheckpoint=0");
    writeMany(db, 1500);
    // A complete checkpoint, then a write: the WAL restarts from the
    // beginning, and its file keeps its size (no journal_size_limit yet).
    db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
    writeMany(db, 1);
    const reader = new DatabaseSync(file);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM t").get();
    writeMany(db, 2);
    return { file, db, reader };
  }

  // The worker's next result for this file, taken no earlier than `after`.
  async function freshResult(file: string, after = Date.now()) {
    await runCheckpointPass();
    await eventually(() => {
      const result = walCheckpointStatus(file)?.lastResult;
      return result != null && result.at >= after;
    });
    return walCheckpointStatus(file)!.lastResult!;
  }

  it("a large stale file around a small live WAL does not fall back", async () => {
    setCheckpointIntervalForTests(100);
    const { file, db, reader } = staleHighWater("highwater.db");
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
      label: "test",
    });
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(1024 * 1024);
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const result = await freshResult(file, started);
    expect(result.checkpointed!).toBeLessThan(result.log!);
    expect(liveWalBytes(result)!).toBeLessThan(64 * 1024);
    // No complete checkpoint for longer than 3 intervals, but the worker's
    // fresh result shows a small live WAL.
    await runCheckpointPass(result.at + 100);
    expect(walCheckpointStatus(file)!.inlineFallback).toBe(false);
    expect(autocheckpoint(db)).toBe(0);
    reader.exec("COMMIT");
    reader.close();
    forgetWalCheckpoints(file, db);
    db.close();
  }, 30_000);

  it("each file is judged by its own result", async () => {
    setCheckpointIntervalForTests(100);
    const small = staleHighWater("small-live.db");
    const big = (() => {
      const file = join(dir, "big-live.db");
      const db = openDb(file);
      const reader = new DatabaseSync(file);
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM t").get();
      writeMany(db, 100);
      return { file, db, reader };
    })();
    for (const { file, db } of [small, big]) {
      deferWalCheckpoints(db, file, {
        enableInTests: true,
        maxWalBytes: 64 * 1024,
        label: "test",
      });
    }
    const started = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const smallResult = await freshResult(small.file, started);
    const bigResult = await freshResult(big.file, started);
    expect(liveWalBytes(smallResult)!).toBeLessThan(64 * 1024);
    expect(liveWalBytes(bigResult)!).toBeGreaterThan(64 * 1024);
    await runCheckpointPass(Math.max(smallResult.at, bigResult.at) + 100);
    expect(walCheckpointStatus(small.file)!.inlineFallback).toBe(false);
    expect(walCheckpointStatus(big.file)!.inlineFallback).toBe(true);
    expect(autocheckpoint(small.db)).toBe(0);
    expect(autocheckpoint(big.db)).toBe(1000);
    for (const { file, db, reader } of [small, big]) {
      reader.exec("COMMIT");
      reader.close();
      forgetWalCheckpoints(file, db);
      db.close();
    }
  }, 30_000);

  it("journal_size_limit truncates the WAL file when it restarts", async () => {
    const file = join(dir, "limit.db");
    const db = openDb(file);
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 256 * 1024,
    });
    expect(
      Number(
        (db.prepare("PRAGMA journal_size_limit").get() as any)
          .journal_size_limit,
      ),
    ).toBe(256 * 1024);
    writeMany(db, 1500);
    expect((await stat(`${file}-wal`)).size).toBeGreaterThan(1024 * 1024);
    const result = await freshResult(file);
    expect(result.checkpointed).toBe(result.log);
    // The next write restarts the WAL and truncates its file to the limit.
    writeMany(db, 1);
    expect((await stat(`${file}-wal`)).size).toBeLessThanOrEqual(256 * 1024);
    forgetWalCheckpoints(file, db);
    db.close();
  }, 30_000);

  it("the WAL status is counts and ages with the caller's label, never a path", async () => {
    const { file, db, reader } = staleHighWater("status.db");
    deferWalCheckpoints(db, file, {
      enableInTests: true,
      maxWalBytes: 64 * 1024,
      label: "test-kind",
    });
    await freshResult(file);
    await runCheckpointPass();
    const status = walStatus().find((s) => s.label === "test-kind")!;
    expect(status).toMatchObject({
      label: "test-kind",
      inline_fallback: false,
      connections: 1,
      page_size: 4096,
      off: true, // the file is over the limit
    });
    expect(status.wal_file_bytes).toBeGreaterThan(1024 * 1024);
    expect(status.live_wal_bytes!).toBeLessThan(64 * 1024);
    expect(JSON.stringify(walStatus())).not.toContain(dir);
    expect(JSON.stringify(walStatus())).not.toContain("status.db");
    reader.exec("COMMIT");
    reader.close();
    forgetWalCheckpoints(file, db);
    db.close();
  }, 30_000);

  it("liveWalBytes: header plus frames, nothing without a usable result", () => {
    expect(liveWalBytes({ file: "f", at: 0, log: 367, page_size: 4096 })).toBe(
      32 + 367 * 4120,
    );
    expect(liveWalBytes({ file: "f", at: 0, log: 0, page_size: 4096 })).toBe(0);
    expect(liveWalBytes({ file: "f", at: 0, log: 3 })).toBeUndefined();
    expect(
      liveWalBytes({ file: "f", at: 0, error: "x", log: 3, page_size: 4096 }),
    ).toBeUndefined();
  });
});
