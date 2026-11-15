/*
Finding 028 B-3a: the signal path of persist processes that have none of
their own (hub persist servers, forked persist nodes, the standalone binary).
A SIGTERM/SIGINT/SIGHUP commits the writes still queued for a group commit,
then re-raises the signal, so the process still dies by the signal's default
action: no stream is closed and nothing is checkpointed (DESIGN §3.2.4 (ii)).
Each case runs in a child process that loads the built backend (dist).
*/

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PACKAGES = join(__dirname, "..", "..", "..", "..");
const BACKEND_DIST = join(PACKAGES, "backend", "dist");
const CONAT_DIST = join(PACKAGES, "conat", "dist");

// argv: backend dist, conat dist, flush|noflush, stream path
const CHILD = `
const [dist, conatDist, mode, path] = process.argv.slice(2);
const persist = require(dist + "/conat/persist.js");
const storage = require(conatDist + "/persist/storage.js");
persist.installPersistExitGuard();
if (mode === "flush" || mode === "flush-owned") persist.installPersistSignalFlush();
if (mode === "flush-owned") {
  // another handler, installed later, owns the shutdown (like start-server.ts
  // waiting for its forked children): it must still get to finish
  process.once("SIGTERM", () => setTimeout(() => process.exit(42), 200));
}
// hold group commits back, so the writes are still QUEUED at the signal
storage.setWriteBatchWindowMs(60000);
const stream = persist.pstream({ path, noCache: true });
for (let i = 0; i < 5; i++) {
  stream.setQueued({ encoding: 1, raw: Buffer.from("q" + i) }).catch(() => {});
}
process.kill(process.pid, "SIGTERM");
setTimeout(() => {}, 30000); // keep alive until the signal acts
`;

function rows(path: string): number {
  if (!existsSync(`${path}.db`)) return 0;
  const db = new DatabaseSync(`${path}.db`, { readOnly: false });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM messages").get() as any).n);
  } finally {
    db.close();
  }
}

describe("028 B-3a: a signal commits the queued writes, then ends by the signal", () => {
  let dir: string;
  let child: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-signal-"));
    child = join(dir, "child.js");
    writeFileSync(child, CHILD);
    if (!existsSync(join(BACKEND_DIST, "conat", "persist.js"))) {
      throw Error(`build the backend first: no ${BACKEND_DIST}`);
    }
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (mode: "flush" | "noflush" | "flush-owned") => {
    const path = join(dir, mode);
    const r = spawnSync(process.execPath, [child, BACKEND_DIST, CONAT_DIST, mode, path], {
      env: process.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { r, path };
  };

  it("installed: the queued writes are committed, and the process still dies by SIGTERM (no close)", () => {
    const { r, path } = run("flush");
    expect(r.signal).toBe("SIGTERM");
    expect(rows(path)).toBe(5);
  });

  it("control, not installed: the default SIGTERM drops the queued (never acked) writes", () => {
    const { r, path } = run("noflush");
    expect(r.signal).toBe("SIGTERM");
    expect(rows(path)).toBe(0);
  });

  it("another handler owns the shutdown (SA 3351 A4): the writes are committed, NO re-raise; that handler finishes and decides the exit", () => {
    const { r, path } = run("flush-owned");
    expect(r.signal).toBeNull();
    expect(r.status).toBe(42);
    expect(rows(path)).toBe(5);
  });

  it("every persist entry point without its own signal path installs it", () => {
    for (const file of [
      "server/conat/persist/index.ts",
      "server/conat/persist/start-persist-node.ts",
      "backend/bin/conat-persist.cjs",
    ]) {
      expect(readFileSync(join(PACKAGES, file), "utf8")).toMatch(
        /installPersistSignalFlush\(\);/,
      );
    }
  });
});
