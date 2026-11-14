/*
Finding 088: the promotion barrier must not remove a WAL whose frames are not
all in the main file.  The source's own inode becomes the rollback copy, so a
removed WAL with uncheckpointed frames would silently drop committed rows from
it if the promotion then rolls back.  A connection that is not a persist
stream owner (e.g., an integrity_check child) reading the file during the
barrier is the case that blocks the checkpoint.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("promotion barrier checkpoint (finding 088)", () => {
  let root: string;
  let sourcePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "persist-maintenance-088-"));
    sourcePath = join(root, "source.db");
    createBloatedDatabase(sourcePath);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  // The reader is a CHILD PROCESS that is killed at the end, like the
  // integrity_check child, which exits without closing its connection.  (An
  // in-process reader would checkpoint on close through its handle to the
  // unlinked WAL and so hide a lost WAL.)
  let reader: ChildProcess | undefined;
  afterEach(() => {
    reader?.kill("SIGKILL");
    reader = undefined;
  });
  async function startReader(): Promise<ChildProcess> {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN");
db.prepare("SELECT count(*) AS n FROM marker").get();
process.stdout.write("READY\\n");
setInterval(() => {}, 1000);`,
        sourcePath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`reader exited ${code}`)));
      child.stdout!.on("data", (d) => {
        if (`${d}`.includes("READY")) resolve();
      });
    });
    return child;
  }
  async function killReader(): Promise<void> {
    const child = reader;
    reader = undefined;
    if (child == null || child.exitCode != null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }

  // A reader whose snapshot is OLDER than the marker rows, then the marker
  // rows written and their connection closed: those frames can't be moved
  // into the main file while the reader is open, so they stay in the WAL only.
  async function walFramesBehindAReader(): Promise<void> {
    const setup = new DatabaseSync(sourcePath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE marker(id INTEGER PRIMARY KEY)");
    setup.close();
    reader = await startReader();
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
    if (promotionBarrierMs != null) config.promotionBarrierMs = promotionBarrierMs;
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
  });

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

    it("refuses a missing or malformed result", () => {
      expect(() => assertPromotionCheckpointComplete(path(), undefined)).toThrow(
        /checkpoint incomplete/,
      );
      expect(() =>
        assertPromotionCheckpointComplete(path(), {
          busy: 0,
          log: "0",
          checkpointed: "0",
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
