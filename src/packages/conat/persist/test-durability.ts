/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// TESTS ONLY (finding 028): never imported by production code.
// - durability records in a fresh temporary directory, for tests that set up
//   the persist context themselves;
// - the STATEMENT GUARD: on a disk-backed stream's connection, a statement
//   that can write, run while no transaction is open (an autocommit), throws.
//   Under synchronous=FULL an autocommit syncs, so an unarmed one could
//   consume a sync error with no dirty record (DESIGN §3.2.6, V-3).  The
//   statements that start or end a transaction (BEGIN, SAVEPOINT, RELEASE,
//   COMMIT, END), and the two writes that cannot run in one -- the
//   journal_mode switch and a checkpoint -- pass only while the stream's
//   dirty record exists (armed), so an unarmed explicit transaction fails too.
//   Installed on every disk-stream connection of the persist test suites, so
//   a new unarmed write fails the day it is added.

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import {
  createDurabilityRecords,
  type DurabilityRecords,
} from "./durability-records";
import type {
  Database,
  OpenBarrierResult,
  PersistDurabilityRecords,
  PersistOpenBarrier,
  PersistWriteCounter,
} from "./context";

export function testDurabilityRecords({
  root = fs.mkdtempSync(join(tmpdir(), "persist-run-")),
  generation = `test-${randomUUID()}`,
}: { root?: string; generation?: string } = {}): DurabilityRecords {
  return createDurabilityRecords({
    root,
    generation,
    fs: fs as any,
    sha256: (data) => createHash("sha256").update(data).digest("hex"),
    pid: process.pid,
  });
}

// what a statement can do, for the guard
export type GuardedClass = "write" | "armed-only" | undefined;

export function guardedStatementClass(sql: string): GuardedClass {
  const verb = (
    /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*+[^*/])*\*+\/)*([A-Za-z]+)/.exec(
      sql,
    )?.[1] ?? ""
  ).toUpperCase();
  switch (verb) {
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
    case "CREATE":
    case "DROP":
    case "ALTER":
    case "VACUUM":
    case "REINDEX":
    case "ANALYZE":
      return "write";
    case "WITH":
      return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
        ? "write"
        : undefined;
    case "PRAGMA": {
      const m = /\bPRAGMA\s+(?:[\w"]+\s*\.\s*)?(\w+)\s*([=(])?/i.exec(sql);
      const name = m?.[1]?.toLowerCase();
      const sets = m?.[2] != null;
      if (name === "wal_checkpoint") return "armed-only";
      if (name === "journal_mode" && sets) return "armed-only";
      if (name === "incremental_vacuum") return "write";
      if (
        sets &&
        (name === "user_version" ||
          name === "application_id" ||
          name === "schema_version")
      ) {
        return "write";
      }
      // reads, and connection settings that write nothing
      return undefined;
    }
    case "BEGIN":
    case "SAVEPOINT":
    case "RELEASE":
    case "COMMIT":
    case "END":
      // a transaction's start can sync (a cache spill), and its end does:
      // armed only (#139 N-1)
      return "armed-only";
    default:
      // SELECT, EXPLAIN, ROLLBACK
      return undefined;
  }
}

export class UnguardedWriteError extends Error {}

// db's statements that can write throw outside a transaction, and the
// armed-only ones throw unless isArmed()
export function guardStatements(
  db: Database,
  isArmed: () => boolean,
): Database {
  const check = (sql: string) => {
    const cls = guardedStatementClass(sql);
    if (cls == null) return;
    if (cls == "armed-only") {
      if (!isArmed()) {
        throw new UnguardedWriteError(
          `statement guard: an unarmed ${sql.trim().slice(0, 60)}`,
        );
      }
      return;
    }
    if (!(db as any).isTransaction) {
      throw new UnguardedWriteError(
        `statement guard: a write outside a transaction (an autocommit): ${sql.trim().slice(0, 60)}`,
      );
    }
  };
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  db.prepare = ((sql: string, ...rest: any[]) => {
    const stmt = (prepare as any)(sql, ...rest);
    if (guardedStatementClass(sql) == null) return stmt;
    for (const method of ["run", "get", "all", "iterate"]) {
      const f = stmt[method]?.bind(stmt);
      if (f == null) continue;
      stmt[method] = (...args: any[]) => {
        check(sql);
        return f(...args);
      };
    }
    return stmt;
  }) as any;
  db.exec = ((sql: string) => {
    check(sql);
    return exec(sql);
  }) as any;
  return db;
}

// whether the stream of a disk connection has its dirty record
function armedCheck(
  db: Database,
  records: { dirtyPath: (id: string) => string },
): () => boolean {
  return () => {
    const location = (db as any).location?.() as string | undefined;
    if (!location?.endsWith(".db")) return false;
    const id = posix.normalize(location.slice(0, -".db".length));
    return fs.existsSync(records.dirtyPath(id));
  };
}

// a write counter that also guards every disk-stream connection (outermost)
export function guardedWriteCounter(
  inner: PersistWriteCounter | undefined,
  records: { dirtyPath: (id: string) => string },
): PersistWriteCounter {
  return {
    wrap: (db, kind, takeRows) => {
      const counted = inner?.wrap(db, kind, takeRows) ?? db;
      return kind == "disk"
        ? guardStatements(counted, armedCheck(db, records))
        : counted;
    },
    streamOpened: (kind) => inner?.streamOpened(kind),
    stats: () => inner?.stats() ?? {},
  };
}

// An open barrier for tests in this package (which can't use the backend's):
// it fsyncs whichever of the -wal, the .db and their directory exist, with no
// hostile-path checks.  The backend's real barrier has its own tests
// (backend/conat/test/persist/durable-open-barrier.test.ts).
export function testOpenBarrier(): PersistOpenBarrier {
  const runSync = (dbPath: string): OpenBarrierResult => {
    const synced: string[] = [];
    for (const path of [`${dbPath}-wal`, dbPath, posix.dirname(dbPath)]) {
      let fd: number;
      try {
        fd = fs.openSync(path, "r");
      } catch (err) {
        if ((err as any)?.code === "ENOENT") continue;
        return { kind: "discovery", path, why: `${err}` };
      }
      try {
        fs.fsyncSync(fd);
        synced.push(path);
      } catch (err) {
        return {
          kind: "sync-error",
          path,
          errno: `${(err as any)?.code}`,
          synced,
        };
      } finally {
        fs.closeSync(fd);
      }
    }
    return { kind: "ok", synced };
  };
  return { runSync, run: async (dbPath) => runSync(dbPath) };
}

// for initContext in tests: records, the guard and the open barrier
export function testDurabilityContext(): {
  durability: PersistDurabilityRecords;
  writeCounter: PersistWriteCounter;
  openBarrier: PersistOpenBarrier;
} {
  const records = testDurabilityRecords();
  return {
    durability: records,
    writeCounter: guardedWriteCounter(undefined, records),
    openBarrier: testOpenBarrier(),
  };
}
