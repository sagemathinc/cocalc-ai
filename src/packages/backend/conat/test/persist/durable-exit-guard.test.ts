/*
Finding 028, B-1 (E-1): at a NATURAL exit, Node's teardown closes every live
DatabaseSync, which checkpoints it, unarmed, and for a poisoned file is the
close §3.2.4 forbids.  A process that serves disk streams opts in to the
exit guard (installPersistExitGuard), which ends it with process.exit
instead, and the WAL stays.  A library import (no opt-in) exits normally.
Each case runs in a child process that ends naturally; it loads the built
backend (dist), as CI builds the workspace before the tests.
*/

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const BACKEND_DIST = join(__dirname, "..", "..", "..", "dist");

// argv: backend dist, guard|noguard, open|poisoned|closed, stream path
const CHILD = `
const [dist, mode, state, path] = process.argv.slice(2);
const persist = require(dist + "/conat/persist.js");
// 028 (ops0's NOFILE ruling): the test-only NOFILE minimum (test/persist-nofile-hook.js)
require(dist + "/../test/persist-nofile-hook.js").installTestPersistStartupCheck({
  persist,
  durability: require(dist + "/conat/persist-durability.js"),
  context: require(require.resolve("@cocalc/conat/persist/context", { paths: [dist] })),
});
// 028 AS-B2-SYNC-OWNER: a direct open needs an owner (no persist server here)
require(require.resolve("@cocalc/conat/persist/context", { paths: [dist] }))
  .setUnregisteredStreamOwnerForTests(() => "host");
if (mode === "guard") persist.installPersistExitGuard();
const msg = () => ({ encoding: 1, raw: Buffer.from("x".repeat(1000)) });
const stream = persist.pstream({ path, noCache: true });
for (let i = 0; i < 50; i++) stream.set(msg());
if (state === "poisoned") {
  const db = stream.db;
  const exec = db.exec;
  db.exec = (sql) => {
    if (sql === "COMMIT") {
      const err = new Error("disk I/O error");
      err.errcode = 1034;
      err.code = "ERR_SQLITE_ERROR";
      throw err;
    }
    return exec(sql);
  };
  try {
    stream.set(msg());
  } catch {}
}
if (state === "closed") stream.close();
console.log(JSON.stringify({ poisoned: stream.isPoisoned() }));
// the exit code must survive the guard's process.exit
process.exitCode = 3;
`;

function walBytes(path: string): number | undefined {
  const wal = `${path}.db-wal`;
  return existsSync(wal) ? statSync(wal).size : undefined;
}

describe("028 B-1 E-1: the exit guard (a natural exit must not close disk streams)", () => {
  let dir: string;
  let child: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-exit-"));
    child = join(dir, "child.js");
    writeFileSync(child, CHILD);
    if (!existsSync(join(BACKEND_DIST, "conat", "persist.js"))) {
      throw Error(`build the backend first: no ${BACKEND_DIST}`);
    }
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function run(mode: "guard" | "noguard", state: string) {
    const path = join(dir, `${mode}-${state}`);
    const r = spawnSync(
      process.execPath,
      [child, BACKEND_DIST, mode, state, path],
      {
        env: process.env,
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    // ended on its own (not killed by the timeout), with its exit code
    expect(r.signal).toBe(null);
    expect(r.status).toBe(3);
    const out = r.stdout.trim().split("\n").pop()!;
    return { path, out: JSON.parse(out), wal: walBytes(path) };
  }

  it("opted in, an open stream: the -wal is kept, not checkpointed by teardown", () => {
    const { out, wal } = run("guard", "open");
    expect(out.poisoned).toBe(false);
    expect(wal).toBeGreaterThan(0);
  });

  it("opted in, a poisoned stream: the -wal is kept (no forbidden close)", () => {
    const { out, wal } = run("guard", "poisoned");
    expect(out.poisoned).toBe(true);
    expect(wal).toBeGreaterThan(0);
  });

  it("opted in, every stream closed durably: a normal exit", () => {
    const { wal } = run("guard", "closed");
    // the stream's own (armed, checked) close checkpointed and removed it
    expect(wal).toBeUndefined();
  });

  it("a library import (no opt-in) exits normally: Node's teardown closes the connection", () => {
    // this is what the guard prevents: the open connection was closed, so
    // checkpointed, by Node itself (vanta's probe, pinned)
    const { out, wal } = run("noguard", "open");
    expect(out.poisoned).toBe(false);
    expect(wal).toBeUndefined();
  });

  it("every entry point that serves disk streams opts in", () => {
    // the processes that open disk streams (pstream callers outside tests):
    // the hub and its forked persist nodes, lite, the project-host (its own
    // persist server, and persist-storage) and its persist daemon, and the
    // backend's standalone persist server (bin/conat-persist.cjs, review
    // B1-R9).  The conat benchmark ends with process.exit.
    const packages = join(__dirname, "..", "..", "..", "..");
    for (const file of [
      "server/conat/persist/index.ts",
      "server/conat/persist/start-persist-node.ts",
      "lite/main.ts",
      "project-host/main.ts",
      "project-host/conat-persist-daemon.ts",
      "backend/bin/conat-persist.cjs",
    ]) {
      const source = readFileSync(join(packages, file), "utf8");
      expect([file, source.includes("  installPersistExitGuard();\n")]).toEqual(
        [file, true],
      );
    }
  });

  it("a worker thread can't open a disk stream (its exit always closes)", async () => {
    const path = join(dir, "worker");
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const persist = require(workerData.dist + "/conat/persist.js");
      try {
        persist.pstream({ path: workerData.path, noCache: true });
        parentPort.postMessage("opened");
      } catch (err) {
        parentPort.postMessage(String(err));
      }
      `,
      { eval: true, workerData: { dist: BACKEND_DIST, path } },
    );
    const result = await new Promise((resolve) =>
      worker.once("message", resolve),
    );
    await worker.terminate();
    expect(result).toMatch(/not opened in a worker thread/);
    expect(existsSync(`${path}.db`)).toBe(false);
  });
});
