/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { DATABASE_SYNC_SOURCE, DatabaseSync } from "./sqlite";

// The same checks, run as worker code: under Node, and under Bun (the adapter
// over bun:sqlite) when bun is installed.
const CHECKS = `
const DatabaseSync = ${DATABASE_SYNC_SOURCE};
const path = process.argv[process.argv.length - 1];
const out = {};
const db = new DatabaseSync(path);
db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)");
const insert = db.prepare("INSERT INTO t (name, data) VALUES (?, ?)");
out.run = insert.run("a", Buffer.from("xy"));
insert.run("b", null);
out.named = db.prepare("SELECT name FROM t WHERE id = :id").get({ id: 2 });
out.missing = db.prepare("SELECT * FROM t WHERE id = 99").get() === undefined;
out.all = db.prepare("SELECT id, name FROM t ORDER BY id").all();
out.iterate = [...db.prepare("SELECT name FROM t ORDER BY id").iterate()].map((r) => r.name);
out.blob = Buffer.from(db.prepare("SELECT data FROM t WHERE id = 1").get().data).toString();
out.isOpen = db.isOpen;
db.close();
const ro = new DatabaseSync(path, { readOnly: true });
try {
  ro.exec("INSERT INTO t (name) VALUES ('c')");
  out.readOnly = "writable";
} catch (err) {
  // node:sqlite's error shape (sqlite-checkpoint reads errcode)
  out.readOnly = { code: err.code, errcode: err.errcode, errstr: typeof err.errstr };
}
ro.close();
// close() releases the connection: its locks and its open transaction, even
// with a prepared statement still referenced, which close() finalizes
const lockPath = path + "-lock";
const a = new DatabaseSync(lockPath);
a.exec("CREATE TABLE l (x)");
a.exec("BEGIN EXCLUSIVE");
a.exec("INSERT INTO l VALUES (1)");
const retained = a.prepare("SELECT * FROM l");
retained.all();
a.close();
const b = new DatabaseSync(lockPath);
b.exec("INSERT INTO l VALUES (2)");
out.afterClose = b.prepare("SELECT x FROM l").all();
b.close();
try {
  retained.all();
  out.retainedAfterClose = "usable";
} catch {
  out.retainedAfterClose = "finalized";
}
console.log(JSON.stringify(out));
`;

const EXPECTED = {
  run: { changes: 1, lastInsertRowid: 1 },
  named: { name: "b" },
  missing: true,
  all: [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ],
  iterate: ["a", "b"],
  blob: "xy",
  isOpen: true,
  readOnly: { code: "ERR_SQLITE_ERROR", errcode: 8, errstr: "string" },
  // the open transaction was rolled back
  afterClose: [{ x: 2 }],
  retainedAfterClose: "finalized",
};

describe("@cocalc/backend/sqlite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cocalc-sqlite-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is node:sqlite's DatabaseSync under Node", () => {
    expect(DatabaseSync).toBe(require("node:sqlite").DatabaseSync);
  });

  it("works as worker code (DATABASE_SYNC_SOURCE) under Node", async () => {
    const path = join(dir, "node.db");
    const output = await new Promise<string>((resolve, reject) => {
      const worker = new Worker(
        `process.argv.push(${JSON.stringify(path)});
         const log = console.log;
         console.log = (s) => require("node:worker_threads").parentPort.postMessage(s);
         ${CHECKS}
         console.log = log;`,
        { eval: true },
      );
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(JSON.parse(output)).toEqual(EXPECTED);
  });

  const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
  (bun.status === 0 ? it : it.skip)(
    "behaves the same under Bun (the adapter over bun:sqlite)",
    () => {
      const path = join(dir, "bun.db");
      // (from the temp directory: no tsconfig.json for bun to read)
      const r = spawnSync("bun", ["-e", CHECKS, path], {
        encoding: "utf8",
        cwd: dir,
      });
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout)).toEqual(EXPECTED);
    },
  );
});
