/*
Finding 088: the promotion barrier must not remove a WAL whose frames are not
all in the main file.  The source's own inode becomes the rollback copy, so a
removed WAL with uncheckpointed frames would silently drop committed rows from
it if the promotion then rolls back.  A connection that is not a persist
stream owner (e.g., an integrity_check child) reading the file during the
barrier is the case that blocks the checkpoint.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { syncFiles } from "@cocalc/backend/data";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  assertPromotionCheckpointComplete,
  PersistMaintenanceCoordinator,
} from "@cocalc/backend/conat/persist-maintenance/coordinator";
import {
  createBloatedDatabase,
  maintenanceTestConfig,
} from "@cocalc/backend/conat/test/persist-maintenance/helpers";

const MARKERS = 50;
// (028 B-2: the compaction worker's own checkpoint waits out its 5 s
// busy_timeout behind the blocking reader before it refuses, so the two
// blocked cases need more than jest's 5 s default)
const BLOCKED_TIMEOUT_MS = 20_000;

describe("promotion barrier checkpoint (finding 088)", () => {
  let root: string;
  let sourcePath: string;

  beforeEach(async () => {
    // (028 B-2, B2-M1: a maintained file's owner must be derivable, so the
    // root lives under the persist root, as in coordinator.test.ts; this and
    // BLOCKED_TIMEOUT_MS are the only changes to #195's test in the merged tree)
    mkdirSync(syncFiles.local, { recursive: true });
    root = await mkdtemp(join(syncFiles.local, "persist-maintenance-088-"));
    sourcePath = join(root, "source.db");
    createBloatedDatabase(sourcePath);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // the reader is killed and reaped before its database is removed
    await killReader();
    await rm(root, { recursive: true, force: true });
  });

  // The reader is a CHILD PROCESS that is killed at the end, like the
  // integrity_check child, which exits without closing its connection.  (An
  // in-process reader would checkpoint on close through its handle to the
  // unlinked WAL and so hide a lost WAL.)  It is tracked from the moment it is
  // spawned, its readiness wait is bounded, and every exit path kills it
  // through its own handle and waits for it to exit.
  const READY_TIMEOUT_MS = 10_000;
  let reader: ChildProcess | undefined;
  let lastReader: ChildProcess | undefined;
  // hold: keep a read transaction open (blocks the checkpoint); idle: read
  // once in autocommit and stay idle with the file open; stall: never ready.
  async function startReader(
    mode: "hold" | "idle" | "stall" = "hold",
    readyTimeoutMs = READY_TIMEOUT_MS,
  ): Promise<void> {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
if (process.argv[2] === "hold") db.exec("BEGIN");
if (process.argv[2] !== "stall") {
  db.prepare("SELECT count(*) AS n FROM marker").get();
  process.stdout.write("READY\\n");
}
setInterval(() => {}, 1000);`,
        sourcePath,
        mode,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    reader = child;
    lastReader = child;
    let out = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`reader not ready after ${readyTimeoutMs} ms`)),
          readyTimeoutMs,
        );
        const done = (err?: Error) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        child.once("error", done);
        child.once("exit", (code, signal) =>
          done(new Error(`reader exited before READY (${code ?? signal})`)),
        );
        child.stdout!.on("data", (d) => {
          out += d;
          if (out.includes("READY\n")) done();
        });
      });
    } catch (err) {
      await killReader();
      throw err;
    }
  }
  async function killReader(): Promise<void> {
    const child = reader;
    reader = undefined;
    if (child == null) return;
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
    }
    child.stdout?.destroy();
  }

  // A reader whose snapshot is OLDER than the marker rows, then the marker
  // rows written and their connection closed: those frames can't be moved
  // into the main file while the reader is open, so they stay in the WAL only.
  async function walFramesBehindAReader(): Promise<void> {
    const setup = new DatabaseSync(sourcePath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE marker(id INTEGER PRIMARY KEY)");
    setup.close();
    await startReader("hold");
    const writer = new DatabaseSync(sourcePath);
    writer.exec("PRAGMA wal_autocheckpoint=0");
    const insert = writer.prepare("INSERT INTO marker(id) VALUES (?)");
    for (let i = 1; i <= MARKERS; i++) insert.run(i);
    writer.close();
    expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);
  }

  function markerCount(): number {
    const db = new DatabaseSync(sourcePath);
    try {
      return Number(
        (db.prepare("SELECT count(*) AS n FROM marker").get() as any).n,
      );
    } finally {
      db.close();
    }
  }

  function coordinatorWith(promotionBarrierMs?: number) {
    const config = maintenanceTestConfig({
      root,
      catalogPath: join(root, ".maintenance", "catalog.sqlite"),
    });
    if (promotionBarrierMs != null)
      config.promotionBarrierMs = promotionBarrierMs;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
    });
    coordinator.createLocalHooks("0");
    return coordinator;
  }

  it("aborts the promotion with every file intact while another connection blocks the checkpoint", async () => {
    await walFramesBehindAReader();
    const before = statSync(sourcePath);
    const coordinator = coordinatorWith();
    await coordinator.tick();
    expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
    // nothing was removed or swapped: same inode, the WAL still there
    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    await killReader();
    coordinator.close();
    expect(markerCount()).toBe(MARKERS);
  }, BLOCKED_TIMEOUT_MS);

  it("keeps every committed row when a promotion would roll back after a blocked checkpoint", async () => {
    // promotionBarrierMs -1 forces the rollback path: before the fix, the WAL
    // was removed first and the restored source lost the marker rows
    await walFramesBehindAReader();
    const before = statSync(sourcePath);
    const coordinator = coordinatorWith(-1);
    await coordinator.tick();
    expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
    expect(statSync(sourcePath).ino).toBe(before.ino);
    await killReader();
    coordinator.close();
    expect(markerCount()).toBe(MARKERS);
  }, BLOCKED_TIMEOUT_MS);

  it("aborts the promotion while an idle connection in another process has the file open", async () => {
    // the checkpoint itself completes (nothing blocks it), so only the
    // WAL-still-present check can refuse: our close leaves the WAL in place
    // because the other process still has the database open
    const setup = new DatabaseSync(sourcePath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE marker(id INTEGER PRIMARY KEY)");
    const insert = setup.prepare("INSERT INTO marker(id) VALUES (?)");
    for (let i = 1; i <= MARKERS; i++) insert.run(i);
    setup.close();
    await startReader("idle");
    const before = statSync(sourcePath);
    const coordinator = coordinatorWith();
    const promote = jest.spyOn(coordinator as any, "promote");
    await coordinator.tick();
    // refused by the WAL-still-present check, not by the checkpoint result
    expect(promote).toHaveBeenCalledTimes(1);
    expect(promote.mock.results[0].type).toBe("throw");
    expect(String(promote.mock.results[0].value)).toMatch(/still present/);
    expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    expect(existsSync(`${sourcePath}-shm`)).toBe(true);
    await killReader();
    coordinator.close();
    expect(markerCount()).toBe(MARKERS);
  });

  it("kills and reaps a reader that never becomes ready, within the bound", async () => {
    await expect(startReader("stall", 500)).rejects.toThrow(
      /not ready after 500 ms/,
    );
    expect(reader).toBeUndefined();
    expect(lastReader?.signalCode).toBe("SIGKILL");
    expect(() => process.kill(lastReader!.pid!, 0)).toThrow();
  });

  it("still promotes when no other connection holds the file", async () => {
    const setup = new DatabaseSync(sourcePath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE marker(id INTEGER PRIMARY KEY)");
    const insert = setup.prepare("INSERT INTO marker(id) VALUES (?)");
    for (let i = 1; i <= MARKERS; i++) insert.run(i);
    setup.close();
    const before = statSync(sourcePath).size;
    const coordinator = coordinatorWith();
    await coordinator.tick();
    expect(coordinator.status()).toMatchObject({ successes: 1, failures: 0 });
    expect(statSync(sourcePath).size).toBeLessThan(before);
    coordinator.close();
    expect(markerCount()).toBe(MARKERS);
  });

  describe("assertPromotionCheckpointComplete", () => {
    const path = () => join(root, "unit.db");

    it("accepts a complete TRUNCATE checkpoint with the WAL gone", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: 0,
          checkpointed: 0,
        }),
      ).not.toThrow();
    });

    it("accepts a database that is not in WAL mode", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: -1,
          checkpointed: -1,
        }),
      ).not.toThrow();
    });

    it("refuses a busy checkpoint", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 1,
          log: 0,
          checkpointed: 0,
        }),
      ).toThrow(/checkpoint incomplete/);
    });

    it("refuses a partial checkpoint", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: 12,
          checkpointed: 7,
        }),
      ).toThrow(/checkpoint incomplete/);
    });

    it("refuses a missing result", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), undefined),
      ).toThrow(/checkpoint incomplete/);
    });

    it("refuses a busy value that is not exactly the number 0", () => {
      for (const busy of ["0", 0n, null, false]) {
        expect(() =>
          assertPromotionCheckpointComplete(path(), {
            busy,
            log: 0,
            checkpointed: 0,
          }),
        ).toThrow(/checkpoint incomplete/);
      }
    });

    it("refuses a log that is not a number", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: "0",
          checkpointed: "0",
        }),
      ).toThrow(/checkpoint incomplete/);
    });

    it("refuses a log that is not an integer", () => {
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: 1.5,
          checkpointed: 1.5,
        }),
      ).toThrow(/checkpoint incomplete/);
    });

    it("refuses when the WAL is still present (another connection has the file)", () => {
      const db = new DatabaseSync(path());
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE t(x)");
      try {
        expect(existsSync(`${path()}-wal`)).toBe(true);
        expect(() =>
          assertPromotionCheckpointComplete(path(), {
            busy: 0,
            log: 0,
            checkpointed: 0,
          }),
        ).toThrow(/still present/);
      } finally {
        db.close();
      }
    });
  });
});
