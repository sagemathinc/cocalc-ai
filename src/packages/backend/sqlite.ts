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

  class StatementSync {
    constructor(
      private readonly stmt: any,
      readonly sourceSQL: string,
    ) {}
    all(...params: any[]) {
      return this.stmt.all(...params);
    }
    get(...params: any[]) {
      // node:sqlite returns undefined for no row; bun:sqlite returns null
      const row = this.stmt.get(...params);
      return row === null ? undefined : row;
    }
    run(...params: any[]) {
      const { changes, lastInsertRowid } = this.stmt.run(...params);
      return { changes, lastInsertRowid };
    }
    *iterate(...params: any[]) {
      yield* this.stmt.iterate(...params);
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
    setReadBigInts(enabled: boolean) {
      this.stmt.safeIntegers(enabled);
    }
    setAllowBareNamedParameters(_enabled: boolean) {
      // bare names are always allowed ({ strict: true } below)
    }
  }

  class DatabaseSync {
    private db: any = null;
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
      this.db = this.options.readOnly
        ? new Database(this.path, { readonly: true, strict: true })
        : new Database(this.path, {
            readwrite: true,
            create: true,
            strict: true,
          });
      if (this.options.timeout) {
        this.db.exec(`PRAGMA busy_timeout = ${Number(this.options.timeout)}`);
      }
      // node:sqlite's default
      if (this.options.enableForeignKeyConstraints !== false) {
        this.db.exec("PRAGMA foreign_keys = ON");
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
      this.connection().exec(sql);
    }
    prepare(sql: string) {
      return new StatementSync(this.connection().prepare(sql), sql);
    }
    close() {
      this.connection().close();
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
