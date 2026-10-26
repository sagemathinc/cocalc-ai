import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { data } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import {
  deferWalCheckpoints,
  forgetWalCheckpoints,
} from "@cocalc/backend/sqlite-checkpoint";

type Statement = {
  run: (...args: any[]) => any;
  all: (...args: any[]) => any[];
  get: (...args: any[]) => any;
};

export type SqliteDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => Statement;
  close: () => void;
};

export interface AcpDatabaseOptions {
  filename?: string;
  legacyFilename?: string;
}

const logger = getLogger("lite:hub:sqlite:acp-database");
const LEGACY_ATTACH_ALIAS = "legacy_acp";
const MIGRATION_META_TABLE = "acp_migration_meta";
const ACP_SQLITE_SLOW_MS = Math.max(
  0,
  Number(process.env.COCALC_ACP_SQLITE_SLOW_MS ?? 250) || 250,
);

let db: SqliteDatabase | undefined;
let dbFilename: string | undefined;
let legacyFilename: string | undefined;
let migrationMetaReady = false;

function ensureDirectory(file: string): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
}

function normalizeFilename(value?: string): string | undefined {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function defaultSharedFilename(): string {
  const dataDir =
    normalizeFilename(process.env.COCALC_DATA_DIR) ??
    normalizeFilename(process.env.DATA) ??
    normalizeFilename(data);
  if (dataDir) {
    return path.join(dataDir, "hub.db");
  }
  return path.join(process.cwd(), "data", "lite", "hub", "sqlite.db");
}

function resolveSharedFilename(): string {
  return (
    normalizeFilename(process.env.COCALC_LITE_SQLITE_FILENAME) ??
    defaultSharedFilename()
  );
}

function defaultAcpFilenameFromShared(sharedFilename: string): string {
  if (sharedFilename === ":memory:") {
    return ":memory:";
  }
  return path.join(path.dirname(sharedFilename), "acp.sqlite");
}

function resolveAcpFilename(options: AcpDatabaseOptions): string {
  const explicit =
    normalizeFilename(options.filename) ??
    normalizeFilename(process.env.COCALC_LITE_ACP_SQLITE_FILENAME);
  if (explicit) {
    return explicit;
  }
  return defaultAcpFilenameFromShared(resolveSharedFilename());
}

function resolveLegacyFilename(
  options: AcpDatabaseOptions,
  acpFilename: string,
): string | undefined {
  const explicit =
    normalizeFilename(options.legacyFilename) ??
    normalizeFilename(process.env.COCALC_LITE_ACP_LEGACY_SQLITE_FILENAME) ??
    resolveSharedFilename();
  if (!explicit || explicit === acpFilename) {
    return;
  }
  if (explicit !== ":memory:" && !existsSync(explicit)) {
    return;
  }
  return explicit;
}

function summarizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 200);
}

function isDatabaseLockedError(err: unknown): boolean {
  return `${(err as any)?.message ?? err ?? ""}`.includes("database is locked");
}

function logLockedOperation({
  filename,
  op,
  sql,
  elapsedMs,
  err,
}: {
  filename: string;
  op: "exec" | "run" | "all" | "get";
  sql: string;
  elapsedMs: number;
  err: unknown;
}): void {
  logger.warn("ACP sqlite database is locked", {
    filename,
    op,
    sql: summarizeSql(sql),
    elapsed_ms: Math.round(elapsedMs),
    pid: process.pid,
    worker_id: `${process.env.COCALC_ACP_INSTANCE_ID ?? ""}`.trim() || null,
    err: `${err}`,
  });
}

function logSlowOperation({
  filename,
  op,
  sql,
  elapsedMs,
}: {
  filename: string;
  op: "exec" | "run" | "all" | "get";
  sql: string;
  elapsedMs: number;
}): void {
  logger.warn("ACP sqlite operation was slow", {
    filename,
    op,
    sql: summarizeSql(sql),
    elapsed_ms: Math.round(elapsedMs),
    slow_ms: ACP_SQLITE_SLOW_MS,
    pid: process.pid,
    worker_id: `${process.env.COCALC_ACP_INSTANCE_ID ?? ""}`.trim() || null,
  });
}

function logSlowOperationIfNeeded({
  filename,
  op,
  sql,
  startedAt,
}: {
  filename: string;
  op: "exec" | "run" | "all" | "get";
  sql: string;
  startedAt: number;
}): void {
  const elapsedMs = performance.now() - startedAt;
  if (elapsedMs >= ACP_SQLITE_SLOW_MS) {
    logSlowOperation({ filename, op, sql, elapsedMs });
  }
}

function wrapStatement(
  raw: Statement,
  filename: string,
  sql: string,
): Statement {
  const wrap =
    (method: keyof Statement) =>
    (...args: any[]): any => {
      const started = performance.now();
      try {
        return (raw[method] as any)(...args);
      } catch (err) {
        if (isDatabaseLockedError(err)) {
          logLockedOperation({
            filename,
            op: method as "run" | "all" | "get",
            sql,
            elapsedMs: performance.now() - started,
            err,
          });
        }
        throw err;
      } finally {
        logSlowOperationIfNeeded({
          filename,
          op: method as "run" | "all" | "get",
          sql,
          startedAt: started,
        });
      }
    };
  return {
    run: wrap("run"),
    all: wrap("all"),
    get: wrap("get"),
  };
}

function wrapDatabase(raw: DatabaseSync, filename: string): SqliteDatabase {
  return {
    exec(sql: string): void {
      const started = performance.now();
      try {
        raw.exec(sql);
      } catch (err) {
        if (isDatabaseLockedError(err)) {
          logLockedOperation({
            filename,
            op: "exec",
            sql,
            elapsedMs: performance.now() - started,
            err,
          });
        }
        throw err;
      } finally {
        logSlowOperationIfNeeded({
          filename,
          op: "exec",
          sql,
          startedAt: started,
        });
      }
    },
    prepare(sql: string): Statement {
      return wrapStatement(raw.prepare(sql) as Statement, filename, sql);
    },
    close(): void {
      raw.close();
    },
  };
}

function ensureMigrationMetaTable(): void {
  if (migrationMetaReady) {
    return;
  }
  const database = getAcpDatabase();
  database.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_META_TABLE} (
      table_name TEXT PRIMARY KEY,
      migrated_at INTEGER NOT NULL,
      source_filename TEXT
    )
  `);
  migrationMetaReady = true;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function tableExists(
  database: SqliteDatabase,
  schema: string,
  table: string,
): boolean {
  const row = database
    .prepare(
      `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    )
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

function listColumns(
  database: SqliteDatabase,
  schema: string,
  table: string,
): string[] {
  return (
    (database
      .prepare(`PRAGMA ${schema}.table_info(${quoteIdent(table)})`)
      .all() as Array<{ name?: string }>) ?? []
  )
    .map((row) => `${row?.name ?? ""}`.trim())
    .filter(Boolean);
}

function wasTableMigrated(table: string): boolean {
  ensureMigrationMetaTable();
  const row = getAcpDatabase()
    .prepare(
      `SELECT table_name FROM ${MIGRATION_META_TABLE} WHERE table_name = ? LIMIT 1`,
    )
    .get(table) as { table_name?: string } | undefined;
  return row?.table_name === table;
}

function markTableMigrated(table: string, sourceFilename?: string): void {
  ensureMigrationMetaTable();
  getAcpDatabase()
    .prepare(
      `INSERT INTO ${MIGRATION_META_TABLE}(table_name, migrated_at, source_filename)
       VALUES (?, ?, ?)
       ON CONFLICT(table_name) DO UPDATE SET
         migrated_at = excluded.migrated_at,
         source_filename = excluded.source_filename`,
    )
    .run(table, Date.now(), sourceFilename ?? null);
}

function currentLegacyFilename(): string | undefined {
  return legacyFilename;
}

export function ensureAcpTableMigrated(table: string): void {
  ensureMigrationMetaTable();
  if (wasTableMigrated(table)) {
    return;
  }
  const source = currentLegacyFilename();
  if (!source) {
    markTableMigrated(table);
    return;
  }
  const database = getAcpDatabase();
  if (!tableExists(database, "main", table)) {
    throw new Error(`ACP table '${table}' must exist before migration`);
  }
  const attachSql = `ATTACH DATABASE ${quoteString(source)} AS ${LEGACY_ATTACH_ALIAS}`;
  database.exec(attachSql);
  try {
    if (!tableExists(database, LEGACY_ATTACH_ALIAS, table)) {
      markTableMigrated(table, source);
      return;
    }
    const targetCount = Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`)
          .get() as { count?: number } | undefined
      )?.count ?? 0,
    );
    if (targetCount > 0) {
      markTableMigrated(table, source);
      return;
    }
    const targetColumns = listColumns(database, "main", table);
    const legacyColumns = new Set(
      listColumns(database, LEGACY_ATTACH_ALIAS, table),
    );
    const columns = targetColumns.filter((column) => legacyColumns.has(column));
    if (columns.length === 0) {
      markTableMigrated(table, source);
      return;
    }
    const columnList = columns.map(quoteIdent).join(", ");
    database.exec("BEGIN");
    try {
      database.exec(
        `INSERT INTO ${quoteIdent(table)} (${columnList})
         SELECT ${columnList} FROM ${LEGACY_ATTACH_ALIAS}.${quoteIdent(table)}`,
      );
      database.exec("COMMIT");
    } catch (err) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // ignore rollback races
      }
      throw err;
    }
    markTableMigrated(table, source);
    logger.info("migrated ACP sqlite table from shared DB", {
      table,
      source_filename: source,
      filename: dbFilename,
    });
  } finally {
    try {
      database.exec(`DETACH DATABASE ${LEGACY_ATTACH_ALIAS}`);
    } catch {
      // ignore detach errors
    }
  }
}

export function initAcpDatabase(
  options: AcpDatabaseOptions = {},
): SqliteDatabase {
  if (db != null) {
    return db;
  }
  const filename = resolveAcpFilename(options);
  if (filename !== ":memory:") {
    ensureDirectory(filename);
  }
  legacyFilename = resolveLegacyFilename(options, filename);
  dbFilename = filename;
  db = wrapDatabase(new DatabaseSync(filename), filename);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA busy_timeout=5000");
  // Checkpoints fsync; keep them off the event loop.
  deferWalCheckpoints(db, filename);
  return db;
}

export function getAcpDatabase(): SqliteDatabase {
  if (db == null) {
    return initAcpDatabase();
  }
  return db;
}

export function closeAcpDatabase(): void {
  if (db != null) {
    if (dbFilename != null) forgetWalCheckpoints(dbFilename, db);
    db.close();
    db = undefined;
    dbFilename = undefined;
    legacyFilename = undefined;
    migrationMetaReady = false;
  }
}

export function getAcpDatabaseFilename(): string | undefined {
  return dbFilename;
}
