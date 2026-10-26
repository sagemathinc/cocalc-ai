/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  deferWalCheckpoints,
  forgetWalCheckpoints,
  runCheckpointPass,
  setCheckpointWorkerEnabledForTests,
  walCheckpointStatus,
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
