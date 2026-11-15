/*
028 B-2 x 088 (ops0 3710, 3711): the two layers that refuse a reader-blocked
checkpoint, each pinned with a REAL reader in another process.

- The worker: the compaction worker's read-write source connection checks its
  own TRUNCATE checkpoint.  A reader that blocks it makes the worker refuse
  (phase source-open: unproven, the record stays armed) and promote() is
  never called.  #195's two "aborts the promotion" cases in
  promotion-checkpoint.test.ts are refused HERE in the merged tree, before
  promotion: their outcome holds, but they no longer reach promote() or its
  rollback path.
- promote(): a reader that attaches AFTER the worker's checkpoint and BEFORE
  promote's own (088's window) blocks promote's checkpoint, whose row
  withMaintenanceConnection checks: unproven, the record stays armed, the WAL
  is not removed and nothing is swapped.
*/

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { syncFiles } from "@cocalc/backend/data";
import {
  MaintenanceCompletionUnprovenError,
  persistDurabilityRecords,
} from "@cocalc/backend/conat/persist-durability";
import { runPersistMaintenanceWorker } from "@cocalc/backend/conat/persist-maintenance/compact-worker";
import { PersistMaintenanceCoordinator } from "@cocalc/backend/conat/persist-maintenance/coordinator";
import {
  createBloatedDatabase,
  maintenanceTestConfig,
} from "@cocalc/backend/conat/test/persist-maintenance/helpers";

const MARKERS = 50;
// the worker's checkpoint waits out its 5 s busy_timeout behind the reader
const BLOCKED_TIMEOUT_MS = 20_000;

describe("028 B-2 x 088: a reader-blocked checkpoint, per refusal layer", () => {
  let root: string;
  let sourcePath: string;
  let recordCalls: string[];

  beforeEach(async () => {
    // (B2-M1: the owner must be derivable, so the root is under the persist root)
    mkdirSync(syncFiles.local, { recursive: true });
    root = await mkdtemp(join(syncFiles.local, "persist-maintenance-088-layers-"));
    sourcePath = join(root, "source.db");
    createBloatedDatabase(sourcePath);
    // the marker table, in WAL mode; this close is the last connection, so the
    // WAL is checkpointed and removed: the file is settled before the tick
    const setup = new DatabaseSync(sourcePath);
    setup.exec("PRAGMA journal_mode=WAL");
    setup.exec("CREATE TABLE marker(id INTEGER PRIMARY KEY)");
    setup.close();
    // this stream's dirty-record transitions (the real records, called through)
    const id = posix.normalize(sourcePath.replace(/\.db$/, ""));
    const records = persistDurabilityRecords();
    recordCalls = [];
    for (const name of ["arm", "disarm", "poison"] as const) {
      const original = records[name].bind(records) as (...args: any[]) => any;
      jest.spyOn(records, name).mockImplementation(((rid: string, ...rest: any[]) => {
        if (rid === id) recordCalls.push(name);
        return original(rid, ...rest);
      }) as any);
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await killReader();
    await rm(root, { recursive: true, force: true });
  });

  // a reader in a CHILD PROCESS holding a read transaction (it blocks a
  // checkpoint), bounded readiness, always killed and reaped (as in #195)
  let reader: ChildProcess | undefined;
  async function startHoldingReader(): Promise<void> {
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
    reader = child;
    let out = "";
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("reader not ready after 10000 ms")),
          10_000,
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

  // marker rows committed behind the held reader's older snapshot: their
  // frames can't be checkpointed while it is open, so they are in the WAL only
  // (the main file is not written: its identity is unchanged)
  async function walFramesBehindAReader(): Promise<void> {
    await startHoldingReader();
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

  function coordinatorWith(
    workerErrors: unknown[],
    promotionBarrierMs?: number,
  ) {
    const config = maintenanceTestConfig({
      root,
      catalogPath: join(root, ".maintenance", "catalog.sqlite"),
    });
    if (promotionBarrierMs != null)
      config.promotionBarrierMs = promotionBarrierMs;
    const coordinator = new PersistMaintenanceCoordinator({
      expectedWorkerIds: ["0"],
      config,
      // the real worker; its error recorded
      runWorker: async (options) => {
        try {
          return await runPersistMaintenanceWorker(options);
        } catch (err) {
          workerErrors.push(err);
          throw err;
        }
      },
    });
    coordinator.createLocalHooks("0");
    return coordinator;
  }

  it("the worker refuses a reader-blocked source checkpoint: unproven, armed, promote never called", async () => {
    // #195's two blocked cases are refused here, before promotion
    await walFramesBehindAReader();
    const before = statSync(sourcePath);
    const workerErrors: unknown[] = [];
    const coordinator = coordinatorWith(workerErrors);
    const promote = jest.spyOn(coordinator as any, "promote");
    await coordinator.tick();
    expect(workerErrors).toHaveLength(1);
    expect(workerErrors[0]).toBeInstanceOf(MaintenanceCompletionUnprovenError);
    expect(String(workerErrors[0])).toMatch(/phase source-open/);
    expect(String(workerErrors[0])).toMatch(
      /source WAL checkpoint incomplete \(busy=1 /,
    );
    expect(recordCalls).toEqual(["arm"]);
    expect(promote).toHaveBeenCalledTimes(0);
    expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
    expect(statSync(sourcePath).ino).toBe(before.ino);
    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    expect(existsSync(`${sourcePath}-shm`)).toBe(true);
    await killReader();
    coordinator.close();
    expect(markerCount()).toBe(MARKERS);
  }, BLOCKED_TIMEOUT_MS);

  for (const [label, promotionBarrierMs] of [
    ["", undefined],
    [" (the rollback variant: promotionBarrierMs -1)", -1],
  ] as const) {
    it(`promote's own checkpoint blocked after the worker succeeded: unproven, armed, the WAL kept${label}`, async () => {
      const before = statSync(sourcePath);
      const workerErrors: unknown[] = [];
      const coordinator = coordinatorWith(workerErrors, promotionBarrierMs);
      // the reader attaches after the worker's checkpoint and before
      // promote's: in the step awaited immediately before promote()
      const stage = (coordinator as any).stageSecondaryCopies.bind(coordinator);
      jest
        .spyOn(coordinator as any, "stageSecondaryCopies")
        .mockImplementation(async (...args: any[]) => {
          expect(recordCalls).toEqual(["arm", "disarm"]); // the worker settled
          await walFramesBehindAReader();
          return await stage(...args);
        });
      const promote = jest.spyOn(coordinator as any, "promote");
      await coordinator.tick();
      expect(workerErrors).toHaveLength(0);
      expect(promote).toHaveBeenCalledTimes(1);
      expect(promote.mock.results[0].type).toBe("throw");
      const err = promote.mock.results[0].value;
      expect(err).toBeInstanceOf(MaintenanceCompletionUnprovenError);
      expect(String(err)).toMatch(/WAL checkpoint incomplete \(busy=1 /);
      // the worker armed and disarmed; promote's checkpoint stays armed
      expect(recordCalls).toEqual(["arm", "disarm", "arm"]);
      expect(coordinator.status()).toMatchObject({ successes: 0, failures: 1 });
      expect(statSync(sourcePath).ino).toBe(before.ino);
      expect(existsSync(`${sourcePath}-wal`)).toBe(true);
      expect(existsSync(`${sourcePath}-shm`)).toBe(true);
      await killReader();
      coordinator.close();
      expect(markerCount()).toBe(MARKERS);
    }, BLOCKED_TIMEOUT_MS);
  }
});
