/*
Counts the commits of every persist stream connection of this process and logs
the write rate once a minute, to size durability work (finding 028) against
real load.  Hooked into conat/persist/storage through the persist context
(writeCounter), so it stays out of the browser bundle.
*/

import type {
  Database,
  PersistStorageKind,
  PersistWriteCounter,
} from "@cocalc/conat/persist/context";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("persist:write-rate");

type StreamStorageKind = PersistStorageKind;

// Write activity of this process, to size durability work against real load.
// Counts only, never paths, keys, SQL or content.  Every figure is kept per
// storage kind: disk streams are the headline; ephemeral streams are in-memory
// and never reach a disk, so they are reported separately under ephemeral_*.
//
// Scope: the connections PersistentStream opens (one per open stream).  Other
// connections to the same files are not counted: persist maintenance and
// compaction (backend/conat/persist-maintenance), project-host
// persist-storage helpers, and backend/sqlite-checkpoint.
//
// commits = txn_commits + autocommits, counted by countCommits on the
// connection itself rather than from a list of call sites:
// - txn_commits: a COMMIT/END/RELEASE that ended a transaction which changed
//   rows or the schema (runTransaction: set, setMany, delete, resetHistory,
//   metadata, checkpoints, purges, trash steps, the count bookkeeping at
//   open).  A transaction that changed nothing writes no WAL frame and is not
//   counted; a rolled-back one never is.
// - autocommits: a write statement outside a transaction, which SQLite
//   commits by itself (e.g., config() and the deletes its enforceLimits(0)
//   makes, deleteCheckpoint, ensureCurrentEpoch, writes through sqlite()), if
//   it wrote: DML that changed rows, DDL that changed the schema, a
//   journal_mode change, and always VACUUM, REINDEX, ANALYZE,
//   incremental_vacuum and setting user_version/application_id/
//   schema_version.
// - a multi-statement exec runs exactly as written, once.  Outside a
//   transaction it counts as at most ONE autocommit, if it changed rows or the
//   schema: a lower bound, since each of its writing statements commits by
//   itself.  That includes a script that itself runs BEGIN ... COMMIT (its
//   rows are not added).  A script that leaves a transaction open, or ends
//   one that was open, counts like BEGIN or COMMIT.  Storage runs no such
//   script (a test pins that).
// - a failed counter read is counted in count_errors and never reaches the
//   caller.  If the read after a COMMIT fails, that commit is not counted;
//   its rows are dropped at the next BEGIN (runTransaction resets them).
// rows/bytes: messages that insertMessage added in a counted transaction.
//   Deletes, trims, config changes and checkpoint-only commits add none.
// sqlite_commit_call_ms: wall time of the synchronous SQLite COMMIT call on
//   the main thread, for txn_commits only, including any auto-checkpoint it
//   runs.  Under synchronous=OFF it includes no fsync, so it is not the
//   latency a durable commit would have.  Autocommits are not timed.
// count_errors: reads of the counter itself that failed (never passed on to
//   the caller); the commit they were for is then not counted.
// uncounted_connections_total: connections countCommits could not count (no
//   db.isTransaction, node < 22.16).  When it is above 0, the log line says
//   so every minute, so a missing count never looks like a quiet zero.
type WriteKindStats = {
  commits_total: number;
  txn_commits_total: number;
  autocommits_total: number;
  rows_total: number;
  bytes_total: number;
  sqlite_commit_call_ms_total: number;
  sqlite_commit_call_ms_max: number;
  count_errors_total: number;
  uncounted_connections_total: number;
};

function newWriteKindStats(): WriteKindStats {
  return {
    commits_total: 0,
    txn_commits_total: 0,
    autocommits_total: 0,
    rows_total: 0,
    bytes_total: 0,
    sqlite_commit_call_ms_total: 0,
    sqlite_commit_call_ms_max: 0,
    count_errors_total: 0,
    uncounted_connections_total: 0,
  };
}

const writeStats: Record<StreamStorageKind, WriteKindStats> = {
  disk: newWriteKindStats(),
  ephemeral: newWriteKindStats(),
};

type WriteKindWindow = {
  totals: WriteKindStats;
  second_commits: number;
  second_rows: number;
  peak_commits_per_second: number;
  peak_rows_per_second: number;
  sqlite_commit_call_ms_max: number;
};

function newWriteKindWindow(kind: StreamStorageKind): WriteKindWindow {
  return {
    totals: { ...writeStats[kind] },
    second_commits: 0,
    second_rows: 0,
    peak_commits_per_second: 0,
    peak_rows_per_second: 0,
    sqlite_commit_call_ms_max: 0,
  };
}

// Since the last write-rate log line (or the start of logging): the totals
// then, and the busiest clock second, per kind.
const writeWindow = {
  started_at: Date.now(),
  second: 0,
  disk: newWriteKindWindow("disk"),
  ephemeral: newWriteKindWindow("ephemeral"),
};

// A new window: nothing before `now`, including a partly counted second,
// belongs to it.
function resetWriteWindow(now: number): void {
  writeWindow.started_at = now;
  writeWindow.second = 0;
  writeWindow.disk = newWriteKindWindow("disk");
  writeWindow.ephemeral = newWriteKindWindow("ephemeral");
}

export const PERSIST_WRITE_RATE_LOG_INTERVAL_MS = 60_000;
let writeRateTimer: ReturnType<typeof setInterval> | undefined;

function recordCommit(
  kind: StreamStorageKind,
  commit:
    | { autocommit: true }
    | { autocommit?: false; rows: number; bytes: number; commitMs: number },
  now: number = Date.now(),
): void {
  const stats = writeStats[kind];
  const rows = commit.autocommit ? 0 : commit.rows;
  stats.commits_total += 1;
  stats.rows_total += rows;
  if (commit.autocommit) {
    stats.autocommits_total += 1;
  } else {
    stats.txn_commits_total += 1;
    stats.bytes_total += commit.bytes;
    stats.sqlite_commit_call_ms_total += commit.commitMs;
    stats.sqlite_commit_call_ms_max = Math.max(
      stats.sqlite_commit_call_ms_max,
      commit.commitMs,
    );
  }
  const second = Math.floor(now / 1000);
  if (second !== writeWindow.second) {
    writeWindow.second = second;
    writeWindow.disk.second_commits = writeWindow.disk.second_rows = 0;
    writeWindow.ephemeral.second_commits =
      writeWindow.ephemeral.second_rows = 0;
  }
  const w = writeWindow[kind];
  w.second_commits += 1;
  w.second_rows += rows;
  w.peak_commits_per_second = Math.max(
    w.peak_commits_per_second,
    w.second_commits,
  );
  w.peak_rows_per_second = Math.max(w.peak_rows_per_second, w.second_rows);
  if (!commit.autocommit) {
    w.sqlite_commit_call_ms_max = Math.max(
      w.sqlite_commit_call_ms_max,
      commit.commitMs,
    );
  }
}

// Flat, prefixed by kind (disk_commits_total, ephemeral_rows_total, ...).
export function getPersistWriteStats(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of ["disk", "ephemeral"] as const) {
    for (const [key, value] of Object.entries(writeStats[kind])) {
      out[`${kind}_${key}`] = value;
    }
  }
  return out;
}

function writeWindowFields(
  kind: StreamStorageKind,
  seconds: number,
): Record<string, number> {
  const now = writeStats[kind];
  const w = writeWindow[kind];
  const commits = now.commits_total - w.totals.commits_total;
  const txnCommits = now.txn_commits_total - w.totals.txn_commits_total;
  const rows = now.rows_total - w.totals.rows_total;
  const fields = {
    commits,
    txn_commits: txnCommits,
    autocommits: now.autocommits_total - w.totals.autocommits_total,
    rows,
    bytes: now.bytes_total - w.totals.bytes_total,
    commits_per_second: commits / seconds,
    rows_per_second: rows / seconds,
    peak_commits_per_second: w.peak_commits_per_second,
    peak_rows_per_second: w.peak_rows_per_second,
    sqlite_commit_call_ms_avg:
      txnCommits > 0
        ? (now.sqlite_commit_call_ms_total -
            w.totals.sqlite_commit_call_ms_total) /
          txnCommits
        : 0,
    sqlite_commit_call_ms_max: w.sqlite_commit_call_ms_max,
    count_errors: now.count_errors_total - w.totals.count_errors_total,
  };
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[`${kind}_${key}`] = value;
  }
  return out;
}

// One line per interval with the deltas since the previous one; quiet when
// nothing was committed, no counter read failed and every connection is
// counted.  Returns the entry (for tests, which can also pass log).
export function logPersistWriteRate(
  now: number = Date.now(),
  log: (message: string, entry: Record<string, number>) => void = (
    message,
    entry,
  ) => logger.info(message, entry),
): Record<string, number> {
  const seconds = Math.max((now - writeWindow.started_at) / 1000, 0.001);
  const entry: Record<string, number> = {
    window_seconds: Math.round(seconds),
    ...writeWindowFields("disk", seconds),
    ...writeWindowFields("ephemeral", seconds),
    disk_uncounted_connections_total:
      writeStats.disk.uncounted_connections_total,
    ephemeral_uncounted_connections_total:
      writeStats.ephemeral.uncounted_connections_total,
  };
  resetWriteWindow(now);
  if (
    entry.disk_commits > 0 ||
    entry.ephemeral_commits > 0 ||
    entry.disk_count_errors > 0 ||
    entry.ephemeral_count_errors > 0 ||
    entry.disk_uncounted_connections_total > 0 ||
    entry.ephemeral_uncounted_connections_total > 0
  ) {
    log("persist write rate", entry);
  }
  return entry;
}

// The first window starts here, when the first disk stream opens, not when
// this module was loaded.
function startWriteRateLog(): void {
  if (writeRateTimer != null) return;
  resetWriteWindow(Date.now());
  writeRateTimer = setInterval(
    () => logPersistWriteRate(),
    PERSIST_WRITE_RATE_LOG_INTERVAL_MS,
  );
  writeRateTimer.unref?.();
}

// The first word of a statement, after leading whitespace and comments.
// Linear: the alternatives start with different characters and each can
// match a given text in only one way.  The whitespace one takes exactly one
// character, and a block comment can't contain "*/".  (\s+, or a lazy
// /\*[\s\S]*?\*\/ that can run on through the next comment, backtracks
// exponentially: e.g. on many spaces, or many comments, followed by "(".)
// Exported for tests.
export function sqlVerb(sql: string): string {
  const m =
    /^(?:\s|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*+[^*/])*\*+\/)*([A-Za-z]+)/.exec(
      sql,
    );
  return (m?.[1] ?? "").toUpperCase();
}

// What a statement can do to the transaction state, for countCommits:
// - begin: may open a transaction (BEGIN, SAVEPOINT outside one);
// - end: may commit one (COMMIT, END, RELEASE of the outermost savepoint);
// - dml, ddl, journal-mode, other-write: may write;
// - undefined: cannot write or commit: SELECT, EXPLAIN, ROLLBACK, and the
//   PRAGMAs other than those below.  The ones storage uses are reads and
//   connection settings (busy_timeout, locking_mode, trusted_schema,
//   cache_size, synchronous, page_size/page_count/freelist_count reads), plus
//   wal_checkpoint, which copies committed pages and commits nothing.
type SqlClass =
  | "begin"
  | "end"
  | "dml"
  | "ddl"
  | "journal-mode"
  | "other-write"
  | undefined;

export function sqlClass(sql: string): SqlClass {
  switch (sqlVerb(sql)) {
    case "BEGIN":
    case "SAVEPOINT":
      return "begin";
    case "COMMIT":
    case "END":
    case "RELEASE":
      return "end";
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
      return "dml";
    case "WITH":
      return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)
        ? "dml"
        : undefined;
    case "CREATE":
    case "DROP":
    case "ALTER":
      return "ddl";
    case "VACUUM":
    case "REINDEX":
    case "ANALYZE":
      return "other-write";
    case "PRAGMA": {
      const m = /\bPRAGMA\s+(?:[\w"]+\s*\.\s*)?(\w+)\s*([=(])?/i.exec(sql);
      const name = m?.[1]?.toLowerCase();
      const sets = m?.[2] != null;
      if (name === "journal_mode" && sets) return "journal-mode";
      if (name === "incremental_vacuum") return "other-write";
      if (
        sets &&
        (name === "user_version" ||
          name === "application_id" ||
          name === "schema_version")
      ) {
        return "other-write";
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// A script's statements, split at the semicolons outside quotes and
// comments.  Undefined for a script with a trigger (its body has semicolons).
function splitSqlStatements(sql: string): string[] | undefined {
  if (/\bTRIGGER\b/i.test(sql)) return undefined;
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i >= 0 && i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const end = sql.indexOf(c === "[" ? "]" : c, i + 1);
      i = end < 0 ? -1 : end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      i = sql.indexOf("\n", i);
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? -1 : end + 2;
    } else if (c === ";") {
      out.push(sql.slice(start, i));
      start = i += 1;
    } else {
      i += 1;
    }
  }
  out.push(sql.slice(start));
  return out.filter((s) => sqlVerb(s) !== "");
}

// Counts, per storage kind, every commit made on this connection (see
// writeStats), from SQLite's own state (db.isTransaction), so a failed BEGIN,
// COMMIT or statement can't make it drift.  It only observes: every call runs
// exactly as the caller wrote it, once, and the counter's own reads can never
// fail or stop that call (see safely).  A count happens only after the call
// returned.  Statements that can't write or commit are returned untouched.
// Write statements outside a transaction, and BEGIN/COMMIT, cost one or two
// extra reads of total_changes()/schema_version.  Nothing here logs or keeps
// SQL text or bound values.  takeRows returns the messages the transaction
// added and resets them.  Needs db.isTransaction (node 22.16+); a connection
// without it is not counted, and that shows as uncounted_connections_total
// (in the log line too), never as a quiet zero.  Exported for tests.
export function countCommits(
  db: Database,
  kind: StreamStorageKind,
  takeRows: () => { rows: number; bytes: number },
): Database {
  if (typeof (db as any).isTransaction !== "boolean") {
    writeStats[kind].uncounted_connections_total += 1;
    return db;
  }
  const inTransaction = (): boolean => (db as any).isTransaction;
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  const reads: Record<string, any> = {};
  const read = (sql: string, column: string) =>
    ((reads[sql] ??= prepare(sql)).get() as any)[column];
  const totalChanges = (): number =>
    Number(read("SELECT total_changes() AS n", "n"));
  const schemaVersion = (): number =>
    Number(read("PRAGMA schema_version", "schema_version"));
  const journalMode = (): string =>
    String(read("PRAGMA journal_mode", "journal_mode"));
  // the state when the open transaction began
  let txnStart: { changes: number; schema: number } | undefined;

  // The counter's own reads must never throw into the caller nor stop its
  // call (e.g., a BUSY or I/O error reading page 1 after a COMMIT that
  // succeeded).  A failed read is counted in count_errors_total, and the call
  // it was for is then not counted (a transaction whose start could not be
  // read is counted as writing).
  const FAILED = Symbol("failed");
  const safely = <R>(f: () => R): R | typeof FAILED => {
    try {
      return f();
    } catch {
      writeStats[kind].count_errors_total += 1;
      return FAILED;
    }
  };

  // A transaction just ended by a COMMIT (or a script): count it if it wrote.
  // One that changed nothing writes no WAL frame.
  const transactionEnded = (commitMs: number): void => {
    const start = txnStart;
    txnStart = undefined;
    const rows = takeRows();
    if (
      start == null ||
      totalChanges() !== start.changes ||
      schemaVersion() !== start.schema
    ) {
      recordCommit(kind, { ...rows, commitMs });
    }
  };

  const track = <T>(
    cls: SqlClass,
    call: () => T,
    changes?: (result: T) => number,
  ): T => {
    if (cls == null) return call();
    const wasInTransaction = safely(inTransaction);
    if (wasInTransaction === FAILED) return call();
    if (cls === "begin") {
      if (wasInTransaction) return call();
      const start = safely(() => ({
        changes: totalChanges(),
        schema: schemaVersion(),
      }));
      const result = call();
      safely(() => {
        if (inTransaction()) {
          txnStart = start === FAILED ? undefined : start;
        }
      });
      return result;
    }
    if (cls === "end") {
      if (!wasInTransaction) return call();
      const started = performance.now();
      const result = call();
      const commitMs = performance.now() - started;
      safely(() => {
        if (!inTransaction()) transactionEnded(commitMs);
      });
      return result;
    }
    // A write inside a transaction is committed (and counted) by its end.
    if (wasInTransaction) return call();
    // Outside one, SQLite commits it by itself if it wrote anything: a DML
    // statement that changed no row writes no WAL frame.
    const before = safely(() =>
      cls === "ddl"
        ? schemaVersion()
        : cls === "journal-mode"
          ? journalMode()
          : cls === "dml" && changes == null
            ? totalChanges()
            : undefined,
    );
    const result = call();
    if (before !== FAILED) {
      safely(() => {
        const wrote =
          cls === "ddl"
            ? schemaVersion() !== before
            : cls === "journal-mode"
              ? journalMode() !== before
              : cls === "dml"
                ? changes != null
                  ? changes(result) > 0
                  : totalChanges() !== before
                : true;
        if (wrote) recordCommit(kind, { autocommit: true });
      });
    }
    return result;
  };

  // A script of several statements runs exactly as written.  Outside a
  // transaction each of its writing statements commits by itself, but it is
  // counted once if it changed rows or the schema: a lower bound.  (Storage
  // runs no such script; a test pins that.)  A script that opens or ends a
  // transaction is counted like BEGIN or COMMIT.
  const trackScript = (sql: string) => {
    const before = safely(() => ({
      inTransaction: inTransaction(),
      changes: totalChanges(),
      schema: schemaVersion(),
    }));
    const started = performance.now();
    const result = exec(sql);
    const commitMs = performance.now() - started;
    if (before !== FAILED) {
      safely(() => {
        const nowInTransaction = inTransaction();
        if (before.inTransaction) {
          if (!nowInTransaction) transactionEnded(commitMs);
          return;
        }
        if (nowInTransaction) {
          txnStart = { changes: before.changes, schema: before.schema };
          return;
        }
        const changed =
          totalChanges() !== before.changes ||
          schemaVersion() !== before.schema;
        if (changed) recordCommit(kind, { autocommit: true });
      });
    }
    return result;
  };

  db.prepare = ((sql: string, ...rest: any[]) => {
    const stmt = (prepare as any)(sql, ...rest);
    const cls = sqlClass(sql);
    if (cls == null) return stmt;
    const run = stmt.run.bind(stmt);
    const get = stmt.get.bind(stmt);
    const all = stmt.all.bind(stmt);
    const iterate = stmt.iterate.bind(stmt);
    // run()'s changes is sqlite3_changes(): that of the LAST INSERT, UPDATE
    // or DELETE, even for a WITH ... SELECT, so a WITH uses total_changes.
    const runChanges =
      sqlVerb(sql) === "WITH" ? undefined : (r: any) => Number(r?.changes ?? 0);
    stmt.run = (...args: any[]) => track(cls, () => run(...args), runChanges);
    stmt.get = (...args: any[]) => track(cls, () => get(...args));
    stmt.all = (...args: any[]) => track(cls, () => all(...args));
    stmt.iterate = (...args: any[]) => {
      // Runs as it is consumed, so this can't tell what it did: a write
      // outside a transaction counts once, when it starts.  (Storage never
      // iterates a write.)
      if (cls !== "begin" && cls !== "end" && safely(inTransaction) === false) {
        recordCommit(kind, { autocommit: true });
      }
      return iterate(...args);
    };
    return stmt;
  }) as any;

  db.exec = ((sql: string) => {
    // The split only decides how to count; SQLite always gets sql itself.
    const statements = sql.includes(";")
      ? safely(() => splitSqlStatements(sql))
      : [sql];
    if (statements === FAILED || statements == null || statements.length > 1) {
      return trackScript(sql);
    }
    return track(sqlClass(sql), () => exec(sql));
  }) as any;
  return db;
}

export const persistWriteCounter: PersistWriteCounter = {
  // never throws into storage's constructor (which opened db): a connection
  // that can't be wrapped is counted as uncounted instead
  wrap: (db, kind, takeRows) => {
    try {
      return countCommits(db, kind, takeRows);
    } catch {
      writeStats[kind].uncounted_connections_total += 1;
      return db;
    }
  },
  streamOpened: (kind) => {
    if (kind === "disk") startWriteRateLog();
  },
  stats: getPersistWriteStats,
};
