/**
 * Backend-only helper for watching many files and emitting minimal patches.
 *
 * Context:
 * - The frontend no longer owns filesystem watching; a single backend watcher
 *   avoids duplicate reloads and inconsistent merges across clients.
 * - Each path keeps a durable last-on-disk snapshot (SQLite) so we can diff
 *   external edits (e.g., vi/git/rsync) without replaying the full patch
 *   history or holding large blobs in memory.
 * - When a directory watcher fires, the backend loads the file once, diffs
 *   against the stored snapshot, and can append a patchflow patch (or a
 *   deleted marker) using a reserved userId. Clients converge via patchflow
 *   instead of every client reloading from disk.
 * - Filesystem writes done through the file-server can update the stored
 *   snapshot directly, so we do not depend on file events that may be dropped.
 *
 * This module only persists and computes diffs; wiring it to chokidar/file
 * events and patchflow emission happens in higher-level watcher code.
 */
import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  deferWalCheckpoints,
  forgetWalCheckpoints,
} from "../sqlite-checkpoint";
import { DatabaseSync as Database } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { DiffMatchPatch, compressPatch } from "@cocalc/util/dmp";
import { tmpNameSync } from "tmp-promise";
import type { DocCodec } from "@cocalc/sync/patchflow";
import { ensureContainingDirectoryExistsSync } from "@cocalc/backend/misc/ensure-containing-directory-exists";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("sync-fs-watch");

const SNAPSHOT_STORE_SUFFIXES = ["", "-wal", "-shm", "-journal"];
// user_version of a store once fs_heads were carried over from the old one.
const FS_HEADS_CARRIED_OVER = 1;
const FS_HEADS_COLUMNS = [
  "string_id",
  "time",
  "version",
  "heads",
  "lastSeq",
  "formatVersion",
] as const;

// Reads fs_heads from an old store, read-only, in a worker thread: opening a
// large store with a large WAL can take a while, and a read-only connection
// does not checkpoint the old WAL on close.
const READ_FS_HEADS_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  db = new DatabaseSync(workerData.path, { readOnly: true });
  const have = new Set(
    db.prepare("PRAGMA table_info(fs_heads)").all().map((row) => row.name),
  );
  const columns = workerData.columns.filter((name) => have.has(name));
  const rows = have.has("string_id")
    ? db.prepare("SELECT " + columns.join(",") + " FROM fs_heads").all()
    : [];
  parentPort.postMessage({ rows });
} catch (err) {
  parentPort.postMessage({ error: String(err) });
} finally {
  try {
    db?.close();
  } catch {}
}
`;

function readFsHeads(dbPath: string): Promise<Partial<FsHeadRow>[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(READ_FS_HEADS_WORKER, {
      eval: true,
      workerData: { path: dbPath, columns: FS_HEADS_COLUMNS },
    });
    worker.once("message", (message) =>
      message.error ? reject(new Error(message.error)) : resolve(message.rows),
    );
    worker.once("error", reject);
    worker.once("exit", (code) =>
      reject(new Error(`fs_heads reader exited with ${code}`)),
    );
  });
}

type FsHeadRow = {
  string_id: string;
  time: number;
  version: number;
  heads: string | null;
  lastSeq: number | null;
  formatVersion: number | null;
};

/**
 * Carry the fs_heads cache (stream heads and last seq per document, a few
 * MB) over from the old store `oldPath` into `store`, once. Without it the
 * first open of each document after the switch reads its whole stream.
 * Rows the new store already has win. Runs off the event loop, except for
 * the inserts, which are batched.
 */
export async function carryOverFsHeads(
  store: SyncFsWatchStore,
  oldPath: string,
): Promise<number> {
  if (store.fsHeadsCarriedOver()) return 0;
  try {
    await stat(oldPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") throw err;
    // No old store: nothing to carry over, now or later.
    store.markFsHeadsCarriedOver();
    return 0;
  }
  const started = Date.now();
  const rows = await readFsHeads(oldPath);
  for (let i = 0; i < rows.length; i += 500) {
    store.importFsHeads(rows.slice(i, i + 500));
    await new Promise((resolve) => setImmediate(resolve));
  }
  store.markFsHeadsCarriedOver();
  logger.debug("carried sync-fs fs_heads over from the old store", {
    oldPath,
    rows: rows.length,
    ms: Date.now() - started,
  });
  return rows.length;
}
const SNAPSHOT_STORE_REMOVE_RETRY_MS = 60 * 60_000;

// Whether any other connection, in any process and under any user, has the
// store at dbPath open: an open WAL-mode connection holds a shared lock on
// the database file, so switching it out of WAL mode fails ("database is
// locked") until the last one closes. Runs in a worker thread because the
// switch checkpoints the old WAL first. "error" when it can't be known.
const RELEASE_CHECK_WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
let result;
try {
  db = new DatabaseSync(workerData.path);
  db.exec("PRAGMA busy_timeout=0");
  const row = db.prepare("PRAGMA journal_mode=DELETE").get();
  result = row && row.journal_mode === "delete" ? "free" : "error";
} catch (err) {
  result = /locked|busy/i.test(String(err)) ? "in-use" : "error";
} finally {
  try {
    db?.close();
  } catch {}
}
parentPort.postMessage(result);
`;

function snapshotStoreState(
  dbPath: string,
): Promise<"free" | "in-use" | "error"> {
  return new Promise((resolve) => {
    const worker = new Worker(RELEASE_CHECK_WORKER, {
      eval: true,
      workerData: { path: dbPath },
    });
    worker.once("message", resolve);
    worker.once("error", () => resolve("error"));
    worker.once("exit", () => resolve("error"));
  });
}

/**
 * Delete an old snapshot store file (and its -wal/-shm) in the background,
 * starting after `delayMs`: the unlinks run in libuv's thread pool, not on
 * the event loop, and the delay keeps them out of the busy minutes after a
 * start. Nothing in it is needed: a snapshot is only read while its path is
 * watched, and every new watch replaces it from the patch stream first.
 *
 * Processes from the previous release can outlive a project-host restart
 * (the ACP worker, auxiliary daemons) and still have the old store open; it
 * is only deleted once SQLite's own locks show no connection to it in any
 * process, checked again every hour. If that can't be determined, it is
 * left alone.
 */
export function removeSnapshotStoreLater(
  dbPath: string,
  delayMs: number,
  retryMs = SNAPSHOT_STORE_REMOVE_RETRY_MS,
): void {
  const existing = async (base: string): Promise<string[]> => {
    const filenames: string[] = [];
    for (const suffix of SNAPSHOT_STORE_SUFFIXES) {
      try {
        await stat(`${base}${suffix}`);
        filenames.push(`${base}${suffix}`);
      } catch {}
    }
    return filenames;
  };
  const attempt = async () => {
    let base: string;
    try {
      base = join(await realpath(dirname(dbPath)), basename(dbPath));
    } catch {
      return;
    }
    if ((await existing(base)).length === 0) return;
    const state = await snapshotStoreState(base);
    if (state === "in-use") {
      logger.debug("old sync-fs snapshot store still open; retrying later", {
        dbPath,
      });
      schedule(retryMs);
      return;
    }
    if (state === "error") {
      logger.warn("not removing old sync-fs snapshot store: state unknown", {
        dbPath,
      });
      return;
    }
    // The check closed the store and removed its -wal/-shm; list again.
    const filenames = await existing(base);
    const started = Date.now();
    let bytes = 0;
    for (const filename of filenames) {
      try {
        bytes += (await stat(filename)).size;
        await rm(filename, { force: true });
      } catch (err) {
        logger.warn("unable to remove old sync-fs snapshot store", {
          filename,
          err: `${err}`,
        });
      }
    }
    logger.warn("removed old sync-fs snapshot store", {
      dbPath,
      bytes,
      ms: Date.now() - started,
    });
  };
  const schedule = (ms: number) => {
    const timer = setTimeout(() => void attempt(), ms);
    timer.unref?.();
  };
  schedule(delayMs);
}

const dmp = new DiffMatchPatch({
  diffTimeout: 0.5,
});

export interface WatchState {
  path: string;
  content: string;
  hash: string;
  deleted: boolean;
  updatedAt: number;
}

export interface ExternalChange {
  patch?: unknown;
  content: string;
  hash: string;
  deleted: boolean;
}

export function hasNonEmptyPatch(patch: unknown): boolean {
  if (patch == null) return false;
  if (
    Array.isArray(patch) &&
    patch.length === 2 &&
    typeof patch[0] === "number" &&
    Array.isArray(patch[1])
  ) {
    return patch[1].length > 0;
  }
  if (Array.isArray(patch) || typeof (patch as any).length === "number") {
    return Number((patch as any).length) > 0;
  }
  if (typeof (patch as any).size === "number") {
    return Number((patch as any).size) > 0;
  }
  if (typeof (patch as any).byteLength === "number") {
    return Number((patch as any).byteLength) > 0;
  }
  return true;
}

export interface FsHead {
  string_id: string;
  time: string; // PatchId
  version: number;
  heads?: string[];
  lastSeq?: number;
  formatVersion?: number;
}

/**
 * Lightweight backend-only helper that tracks on-disk content for many files
 * and computes patches when the filesystem changes behind our back.
 *
 * - Persists the last known on-disk contents in a sqlite database so we can
 *   diff against the previous version without replaying the full patch stream.
 * - Intended to be driven by a single backend watcher; frontends no longer
 *   need to watch the filesystem directly.
 */
export class SyncFsWatchStore {
  private db: Database;
  private dbPath: string;
  private cleanupDb: boolean;
  private stats = {
    exactHashNoops: 0,
    emptyPatchNoops: 0,
  };

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? tmpNameSync({ prefix: "sync-fs-", postfix: ".db" });
    logger.debug("new SyncFsWatchStore", this.dbPath);
    this.cleanupDb = dbPath == null;
    ensureContainingDirectoryExistsSync(this.dbPath);
    this.db = new Database(this.dbPath);
    this.init();
    // Checkpoints fsync; keep them off the event loop.
    deferWalCheckpoints(this.db, this.dbPath);
  }

  close(): void {
    forgetWalCheckpoints(this.dbPath, this.db);
    this.db?.close();
    if (this.cleanupDb) {
      try {
        unlinkSync(this.dbPath);
      } catch {
        // ignore cleanup failures for tmp files
      }
    }
  }

  private init(): void {
    // Relax locking so concurrent test workers or multiple backend requests
    // do not immediately trip "database is locked" errors.
    // WAL allows concurrent readers/writers; busy_timeout gives SQLite time
    // to retry instead of failing instantly. Wrap in a tiny retry loop in
    // case the pragma itself races with another opener.
    const bootstrap = () => {
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        -- NORMAL: commits do not fsync (the default FULL fsynced every
        -- commit on the event loop). An OS crash or power loss can roll
        -- back the last commits; the snapshots are re-derived from disk.
        PRAGMA synchronous=NORMAL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS files (
          path TEXT PRIMARY KEY,
          -- updatedAt and bytes come before content so that pruning reads
          -- them without walking the content's overflow pages.
          updatedAt INTEGER NOT NULL,
          bytes INTEGER NOT NULL DEFAULT 0,
          deleted INTEGER NOT NULL DEFAULT 0,
          hash TEXT NOT NULL,
          content TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS files_updatedAt ON files(updatedAt);
        -- Paths watched by each process using this store (the project-host
        -- and its ACP worker share it), so no process prunes a snapshot
        -- another one is watching.
        CREATE TABLE IF NOT EXISTS watching (
          path TEXT NOT NULL,
          owner TEXT NOT NULL,
          seenAt INTEGER NOT NULL,
          PRIMARY KEY (path, owner)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS fs_heads (
          string_id TEXT PRIMARY KEY,
          time INTEGER NOT NULL,
          version INTEGER NOT NULL,
          heads TEXT,
          lastSeq INTEGER,
          formatVersion INTEGER
        );
      `);
      // Backward-compatible migrations; ignore if columns already exist.
      try {
        this.db.exec("ALTER TABLE fs_heads ADD COLUMN heads TEXT");
      } catch {}
      try {
        this.db.exec("ALTER TABLE fs_heads ADD COLUMN lastSeq INTEGER");
      } catch {}
      try {
        this.db.exec("ALTER TABLE fs_heads ADD COLUMN formatVersion INTEGER");
      } catch {}
    };

    for (let attempt = 0; ; attempt++) {
      try {
        bootstrap();
        break;
      } catch (err) {
        if (attempt >= 4) {
          throw err;
        }
        // short backoff without introducing async into constructor
        const delay = 10 * (attempt + 1);
        const end = Date.now() + delay;
        while (Date.now() < end) {
          // busy wait briefly
        }
      }
    }
  }

  fsHeadsCarriedOver(): boolean {
    const row = this.db.prepare("PRAGMA user_version").get() as any;
    return Number(row?.user_version ?? 0) >= FS_HEADS_CARRIED_OVER;
  }

  markFsHeadsCarriedOver(): void {
    this.db.exec(`PRAGMA user_version=${FS_HEADS_CARRIED_OVER}`);
  }

  /** Insert fs_heads rows, keeping any row already present. */
  importFsHeads(rows: Partial<FsHeadRow>[]): void {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO fs_heads(${FS_HEADS_COLUMNS.join(",")}) VALUES(?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        if (typeof row.string_id !== "string") continue;
        ins.run(
          row.string_id,
          row.time ?? 0,
          row.version ?? 0,
          row.heads ?? null,
          row.lastSeq ?? null,
          row.formatVersion ?? null,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Record that `owner` (one process) is watching `path`. */
  markWatching(owner: string, path: string, now = Date.now()): void {
    this.db
      .prepare(
        "INSERT INTO watching(path, owner, seenAt) VALUES(?, ?, ?) ON CONFLICT(path, owner) DO UPDATE SET seenAt=excluded.seenAt",
      )
      .run(path, owner, now);
  }

  unmarkWatching(owner: string, path?: string): void {
    if (path == null) {
      this.db.prepare("DELETE FROM watching WHERE owner = ?").run(owner);
    } else {
      this.db
        .prepare("DELETE FROM watching WHERE owner = ? AND path = ?")
        .run(owner, path);
    }
  }

  /**
   * Replace `owner`'s watched paths with `paths`, all seen now, and forget
   * the watches of any process not seen since `expireBefore` (it died).
   */
  refreshWatching({
    owner,
    paths,
    now = Date.now(),
    expireBefore,
  }: {
    owner: string;
    paths: Iterable<string>;
    now?: number;
    expireBefore: number;
  }): void {
    const ins = this.db.prepare(
      "INSERT OR REPLACE INTO watching(path, owner, seenAt) VALUES(?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM watching WHERE owner = ?").run(owner);
      this.db
        .prepare("DELETE FROM watching WHERE seenAt < ?")
        .run(expireBefore);
      for (const path of paths) ins.run(path, owner, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Delete the snapshots of paths that no process is watching (not in `keep`,
   * and no watch seen since `watchedSince` by any process) and that were last
   * updated before `olderThan`, oldest first: at most `maxRows`, and once
   * `maxBytes` of content is reached no more (but always one, since a single
   * row can't be split; freeing it costs about what saving it did). Safe because
   * a snapshot is replaced from the patch stream whenever its path is watched
   * again. Returns how many were deleted, and whether more candidates may
   * remain.
   */
  pruneSnapshots({
    olderThan,
    keep,
    watchedSince,
    maxRows = 100,
    maxBytes = Infinity,
  }: {
    olderThan: number;
    keep: ReadonlySet<string>;
    watchedSince: number;
    maxRows?: number;
    maxBytes?: number;
  }): { deleted: number; more: boolean } {
    const limit = maxRows + keep.size;
    // Select and delete under one write lock (BEGIN IMMEDIATE), so no other
    // process can start watching or rewrite a candidate in between; the
    // DELETE checks the same conditions again on the row it removes.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db
        .prepare(
          `SELECT rowid AS id, path, bytes FROM files INDEXED BY files_updatedAt
           WHERE updatedAt < ?
             AND NOT EXISTS (SELECT 1 FROM watching
                             WHERE watching.path = files.path AND seenAt >= ?)
           ORDER BY updatedAt LIMIT ?`,
        )
        .all(olderThan, watchedSince, limit) as {
        id: number;
        path: string;
        bytes: number;
      }[];
      this.onPruneCandidatesForTests?.();
      const remove = candidates.filter(({ path }) => !keep.has(path));
      const victims: typeof remove = [];
      let bytes = 0;
      for (const row of remove) {
        if (victims.length >= maxRows) break;
        if (victims.length > 0 && bytes + row.bytes > maxBytes) break;
        victims.push(row);
        bytes += row.bytes;
      }
      const del = this.db.prepare(
        `DELETE FROM files
         WHERE rowid = ? AND path = ? AND updatedAt < ?
           AND NOT EXISTS (SELECT 1 FROM watching
                           WHERE watching.path = files.path AND seenAt >= ?)`,
      );
      let deleted = 0;
      for (const { id, path } of victims) {
        deleted += Number(
          del.run(id, path, olderThan, watchedSince).changes ?? 0,
        );
      }
      this.db.exec("COMMIT");
      return {
        deleted,
        more: remove.length > victims.length || candidates.length === limit,
      };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // Tests: called between selecting and deleting, inside the write lock.
  onPruneCandidatesForTests?: () => void;

  get(path: string): WatchState | undefined {
    const row = this.db
      .prepare(
        "SELECT path, content, hash, deleted, updatedAt FROM files WHERE path = ?",
      )
      .get(path) as WatchState | undefined;
    if (!row) return;
    return {
      ...row,
      deleted: !!row.deleted,
    };
  }

  getDebugStats(): { exactHashNoops: number; emptyPatchNoops: number } {
    return { ...this.stats };
  }

  setContent(path: string, content: string): void {
    const hash = this.sha(content);
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO files(path, content, bytes, hash, deleted, updatedAt)
        VALUES(?, ?, ?, ?, 0, ?)
        ON CONFLICT(path) DO UPDATE SET
          content=excluded.content,
          bytes=excluded.bytes,
          hash=excluded.hash,
          deleted=0,
          updatedAt=excluded.updatedAt;
      `,
      )
      .run(path, content, Buffer.byteLength(content), hash, now);
  }

  markDeleted(path: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `
        INSERT INTO files(path, content, bytes, hash, deleted, updatedAt)
        VALUES(?, '', 0, '', 1, ?)
        ON CONFLICT(path) DO UPDATE SET
          content='',
          bytes=0,
          hash='',
          deleted=1,
          updatedAt=excluded.updatedAt;
      `,
      )
      .run(path, now);
  }

  /**
   * Compute a patch from the last known on-disk content to the current content.
   * Updates the stored snapshot and returns both the new content and the patch.
   */
  async handleExternalChange(
    path: string,
    loader: () => Promise<string>,
    deleted = false,
    codec?: DocCodec,
    forceDiff = false,
  ): Promise<ExternalChange> {
    // Only an explicit unlink event may turn the baseline into a deletion.
    const current = deleted ? "" : await loader();
    const currentHash = this.sha(current);
    const prev = this.get(path);

    if (
      !forceDiff &&
      prev &&
      prev.hash === currentHash &&
      !prev.deleted &&
      !deleted
    ) {
      this.stats.exactHashNoops += 1;
      return { content: current, hash: currentHash, deleted: false };
    }

    // Structured documents (patch_format != 0)
    if (codec) {
      try {
        const baseDoc = codec.fromString(prev?.content ?? "");
        const nextDoc = codec.fromString(current);
        const patch = codec.makePatch(baseDoc, nextDoc);
        const nonEmptyPatch = hasNonEmptyPatch(patch);
        this.setContent(path, current);
        if (deleted) this.markDeleted(path);
        if (!nonEmptyPatch) {
          this.stats.emptyPatchNoops += 1;
          return { content: current, hash: currentHash, deleted: false };
        }
        return {
          patch,
          content: current,
          hash: currentHash,
          deleted: false,
        };
      } catch {
        // Fall back to string diff below on codec failure.
      }
    }

    const base = prev?.content ?? "";
    let patch: ReturnType<typeof compressPatch> | undefined;
    try {
      patch = compressPatch(dmp.patch_make(base, current));
    } catch {
      patch = undefined;
    }

    this.setContent(path, current);
    if (deleted) this.markDeleted(path);
    if (!hasNonEmptyPatch(patch)) {
      this.stats.emptyPatchNoops += 1;
      return {
        content: current,
        hash: currentHash,
        deleted: false,
      };
    }
    return {
      patch,
      content: current,
      hash: currentHash,
      deleted: false,
    };
  }

  private sha(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex");
  }

  getFsHead(string_id: string): FsHead | undefined {
    const row = this.db
      .prepare(
        "SELECT string_id, time, version, heads, lastSeq, formatVersion FROM fs_heads WHERE string_id = ?",
      )
      .get(string_id) as FsHead | undefined;
    if (!row) return;
    let heads: string[] | undefined;
    if (typeof (row as any).heads === "string") {
      try {
        heads = JSON.parse((row as any).heads);
      } catch {
        heads = undefined;
      }
    }
    return {
      string_id: row.string_id,
      time: row.time,
      version: row.version,
      heads,
      lastSeq: (row as any).lastSeq,
      formatVersion: (row as any).formatVersion,
    };
  }

  setFsHead(head: FsHead): void {
    this.db
      .prepare(
        `
        INSERT INTO fs_heads(string_id, time, version, heads, lastSeq, formatVersion)
        VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(string_id) DO UPDATE SET
          time=excluded.time,
          version=excluded.version,
          heads=excluded.heads,
          lastSeq=excluded.lastSeq,
          formatVersion=excluded.formatVersion;
      `,
      )
      .run(
        head.string_id,
        head.time,
        head.version,
        head.heads ? JSON.stringify(head.heads) : null,
        head.lastSeq ?? null,
        head.formatVersion ?? null,
      );
  }
}
