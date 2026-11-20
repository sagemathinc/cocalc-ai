/*
A closed stream must be garbage collected.  The connection's prepare/exec are
replaced by closures over the stream (refuseWhenPoisoned) and over the write
counter's cached statements; node:sqlite keeps a database alive from native
code while any of its statements is, so unless close removes those closures,
every closed stream stays in memory (the bay-0 hub leak of 2026-11-19).
*/

import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { statSync, copyFileSync } from "node:fs";
import { testDurabilityContext } from "./test-durability";
import { PersistentStream } from "./storage";
import { initContext, syncFiles } from "./context";

setFlagsFromString("--expose-gc");
const gc: () => void = runInNewContext("gc");

// the shape of backend/conat/persist-write-rate's countCommits: a statement
// cached in a closure stored on the connection
const cachingCounter = {
  wrap: (db: any, _kind: any, takeRows: () => unknown) => {
    const prepare = db.prepare.bind(db);
    const reads: Record<string, any> = {};
    db.prepare = (sql: string, ...rest: any[]) => {
      (reads["SELECT total_changes() AS n"] ??= prepare(
        "SELECT total_changes() AS n",
      )).get();
      takeRows;
      return prepare(sql, ...rest);
    };
    return db;
  },
  streamOpened: () => {},
  stats: () => ({}),
};

function init(writeCounter?: any) {
  initContext({
    ...testDurabilityContext(),
    sqlite: { DatabaseSync },
    compress: (data) => data,
    decompress: (data) => data,
    syncFiles,
    statSync,
    copyFileSync,
    ensureContainingDirectoryExists: async () => undefined,
    writeCounter,
  });
}

async function collectedAfterClose(n: number): Promise<number> {
  const refs: WeakRef<PersistentStream>[] = [];
  for (let i = 0; i < n; i++) {
    const stream = new PersistentStream({
      path: `/tmp/close-leak-test-${i}`,
      ephemeral: true,
    });
    stream.set({ key: "k", encoding: "json", raw: Buffer.from("{}") });
    stream.close();
    refs.push(new WeakRef(stream));
  }
  for (let i = 0; i < 10; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return refs.filter((ref) => ref.deref() == null).length;
}

test("a closed stream is collected (refuseWhenPoisoned's closures)", async () => {
  init();
  expect(await collectedAfterClose(50)).toBeGreaterThanOrEqual(45);
});

test("a closed stream is collected with a counter that caches statements", async () => {
  init(cachingCounter);
  expect(await collectedAfterClose(50)).toBeGreaterThanOrEqual(45);
});

test("close removes the connection's wrappers", () => {
  init(cachingCounter);
  const stream = new PersistentStream({
    path: "/tmp/close-leak-test-wrappers",
    ephemeral: true,
  });
  const db = (stream as any).db;
  expect(Object.prototype.hasOwnProperty.call(db, "prepare")).toBe(true);
  stream.close();
  expect(Object.prototype.hasOwnProperty.call(db, "prepare")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(db, "exec")).toBe(false);
});

// 028: a connection that was NOT closed (here: poisoned) may still be open,
// so it keeps its guard
test("a close that did not happen keeps the connection's wrappers", () => {
  init(cachingCounter);
  const stream = new PersistentStream({
    path: "/tmp/close-leak-test-poisoned",
    ephemeral: true,
  });
  const db = (stream as any).db;
  (stream as any).poisoned = true;
  stream.close();
  expect(Object.prototype.hasOwnProperty.call(db, "prepare")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(db, "exec")).toBe(true);
  expect(() => db.prepare("SELECT 1")).toThrow("had a sync error");
});
