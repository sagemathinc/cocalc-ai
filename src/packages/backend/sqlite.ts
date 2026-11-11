/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
node:sqlite's DatabaseSync on Node and on Bun.  Import DatabaseSync from here,
not from "node:sqlite": Bun doesn't implement node:sqlite, so there it is a
small adapter over bun:sqlite with the part of the API CoCalc uses.

loadDatabaseSync is self-contained (no imports, no outer variables), so worker
code given as a string embeds it through DATABASE_SYNC_SOURCE.  Both builtins
are loaded with process.getBuiltinModule, so bundlers never try to resolve
bun:sqlite.
*/

import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";

export function loadDatabaseSync(): typeof NodeDatabaseSync {
  if (!process.versions.bun) {
    return (process as any).getBuiltinModule("node:sqlite").DatabaseSync;
  }
  const { Database } = (process as any).getBuiltinModule("bun:sqlite");
  // (not in this package's TypeScript lib)
  const WeakRef: new <T>(value: T) => { deref(): T | undefined } = (
    globalThis as any
  ).WeakRef;

  // Errors as node:sqlite throws them: bun:sqlite's SQLiteError has
  // code "SQLITE_..." and errno; node:sqlite's has code "ERR_SQLITE_ERROR",
  // errcode and errstr (sqlite-checkpoint, for one, reads errcode).
  function sqliteCall<T>(f: () => T): T {
    try {
      return f();
    } catch (err: any) {
      if (err?.name !== "SQLiteError" || typeof err.errno !== "number") {
        throw err;
      }
      // (a SQLiteError's fields are read-only)
      const e: any = new Error(err.message);
      e.cause = err;
      e.code = "ERR_SQLITE_ERROR";
      e.errcode = err.errno;
      e.errstr = err.message;
      e.stack = err.stack;
      throw e;
    }
  }

  class StatementSync {
    private readBigInts = false;
    constructor(
      private readonly db: any,
      private stmt: any,
      readonly sourceSQL: string,
    ) {}
    all(...params: any[]) {
      return sqliteCall(() => this.stmt.all(...params));
    }
    get(...params: any[]) {
      // node:sqlite returns undefined for no row; bun:sqlite returns null
      const row = sqliteCall(() => this.stmt.get(...params));
      return row === null ? undefined : row;
    }
    run(...params: any[]) {
      const { changes, lastInsertRowid } = sqliteCall(() =>
        this.stmt.run(...params),
      );
      return { changes, lastInsertRowid };
    }
    *iterate(...params: any[]) {
      const rows = sqliteCall(() => this.stmt.iterate(...params));
      let finished = false;
      let failed = false;
      try {
        while (true) {
          let next;
          try {
            next = sqliteCall(() => rows.next());
          } catch (err) {
            failed = true;
            throw err;
          }
          if (next.done) {
            finished = true;
            return;
          }
          yield next.value;
        }
      } finally {
        // Stopped early (break, return, or an error in the loop body):
        // bun:sqlite's iterator keeps the statement, and its read
        // transaction and table locks, busy until it is collected, and
        // closing it doesn't reset the statement.  Replace the statement
        // with a fresh one, as node:sqlite's stays usable.
        if (!finished) {
          try {
            rows.return?.();
          } catch {}
          try {
            this.stmt.finalize();
          } catch {}
          if (failed) {
            try {
              this.renew();
            } catch {}
          } else {
            this.renew();
          }
        }
      }
    }
    columns() {
      const names: string[] = this.stmt.columnNames ?? [];
      const types: (string | null)[] = this.stmt.declaredTypes ?? [];
      return names.map((name, i) => ({
        name,
        column: name,
        table: null,
        database: "main",
        type: types[i] ?? null,
      }));
    }
    private renew() {
      this.stmt = sqliteCall(() => this.db.prepare(this.sourceSQL));
      if (this.readBigInts) this.stmt.safeIntegers(true);
    }
    setReadBigInts(enabled: boolean) {
      this.readBigInts = enabled;
      this.stmt.safeIntegers(enabled);
    }
    setAllowBareNamedParameters(_enabled: boolean) {
      // bare names are always allowed ({ strict: true } below)
    }
    finalize() {
      this.stmt.finalize();
    }
  }

  class DatabaseSync {
    private db: any = null;
    // Statements still in use, finalized by close(): bun:sqlite keeps the
    // connection (and its locks and open transaction) alive while any
    // statement is, and node:sqlite's close() releases it.  Weak, so that
    // statements that are no longer used can be collected (bun:sqlite then
    // finalizes them); pruned as it grows.
    private statements = new Set<{ deref(): StatementSync | undefined }>();
    private pruneAt = 256;
    constructor(
      private readonly path: string,
      private readonly options: {
        open?: boolean;
        readOnly?: boolean;
        timeout?: number;
        enableForeignKeyConstraints?: boolean;
      } = {},
    ) {
      if (options.open !== false) this.open();
    }
    open() {
      if (this.db != null) throw new Error("database is already open");
      // strict: named parameters bind without their prefix, as in node:sqlite
      this.db = sqliteCall(() =>
        this.options.readOnly
          ? new Database(this.path, { readonly: true, strict: true })
          : new Database(this.path, {
              readwrite: true,
              create: true,
              strict: true,
            }),
      );
      if (this.options.timeout) {
        this.exec(`PRAGMA busy_timeout = ${Number(this.options.timeout)}`);
      }
      // node:sqlite's default
      if (this.options.enableForeignKeyConstraints !== false) {
        this.exec("PRAGMA foreign_keys = ON");
      }
    }
    get isOpen() {
      return this.db != null;
    }
    get isTransaction() {
      return !!this.db?.inTransaction;
    }
    private connection() {
      if (this.db == null) throw new Error("database is not open");
      return this.db;
    }
    exec(sql: string) {
      const db = this.connection();
      sqliteCall(() => db.exec(sql));
    }
    prepare(sql: string) {
      const db = this.connection();
      const stmt = new StatementSync(
        db,
        sqliteCall(() => db.prepare(sql)),
        sql,
      );
      this.statements.add(new WeakRef(stmt));
      if (this.statements.size >= this.pruneAt) {
        for (const ref of this.statements) {
          if (ref.deref() == null) this.statements.delete(ref);
        }
        this.pruneAt = Math.max(256, 2 * this.statements.size);
      }
      return stmt;
    }
    close() {
      const db = this.connection();
      for (const ref of this.statements) {
        try {
          ref.deref()?.finalize();
        } catch {}
      }
      this.statements.clear();
      sqliteCall(() => db.close());
      this.db = null;
    }
  }

  return DatabaseSync as unknown as typeof NodeDatabaseSync;
}

export const DatabaseSync = loadDatabaseSync();
export type DatabaseSync = NodeDatabaseSync;

/**
 * An expression that evaluates to DatabaseSync, for worker code given as a
 * string: `const DatabaseSync = ${DATABASE_SYNC_SOURCE};`
 */
export const DATABASE_SYNC_SOURCE = `(${loadDatabaseSync.toString()})()`;
