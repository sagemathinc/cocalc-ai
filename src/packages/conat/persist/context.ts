/*
Define functions for using sqlite, the filesystem, compression, etc.
These are functions that typically get set via nodejs on the backend,
not from a browser.    Making this explicit helps clarify the dependence
on the backend and make the code more unit testable.
*/

import type { DatabaseSync } from "node:sqlite";
export type Database = DatabaseSync;

let sqliteModule: {
  DatabaseSync: new (...args: any[]) => DatabaseSync;
} | null = null;

export let compress: (data: Buffer) => Buffer = () => {
  throw Error("must initialize persist context");
};

// maxOutputLength: refuse to produce more than this many bytes.  Stored data
// is not trusted (a project's persist files live in the project), so callers
// always pass a limit.
export let decompress: (
  data: Buffer,
  maxOutputLength?: number,
) => Buffer = () => {
  throw Error("must initialize persist context");
};

// Decompression that runs off the event loop (e.g., in the libuv threadpool),
// used for large messages so one huge stored message cannot stall every other
// stream served by the same process.  Defaults to the synchronous version.
export let decompressAsync: (
  data: Buffer,
  maxOutputLength?: number,
) => Promise<Buffer> = async (data, maxOutputLength) =>
  decompress(data, maxOutputLength);

// Called with the path of a database file before it is opened.  Throws if
// opening it is unsafe, e.g., a symlink a project put in its persist
// directory.  The backend sets it; by default it allows everything.
export let assertSafeDatabasePath: (path: string) => void = () => {};

// Whether a database file is in a project, which can change it (and its -wal
// and -shm files) at any time.  The backend sets it; by default nothing is.
export let isProjectOwnedDatabasePath: (path: string) => boolean = () => false;

// Called before a project's databases are opened, with the directory that
// holds them.  A project-host creates that directory (a volume of its own) and
// imports the project's old databases into it; it throws to refuse access.
// By default it does nothing.
export type PrepareProjectStore = (opts: {
  project_id: string;
  root: string;
}) => Promise<void>;
let prepareProjectStoreFn: PrepareProjectStore = async () => {};
export function prepareProjectStore(opts: {
  project_id: string;
  root: string;
}): Promise<void> {
  return prepareProjectStoreFn(opts);
}
export function setPrepareProjectStore(fn: PrepareProjectStore): void {
  prepareProjectStoreFn = fn;
}

// Counts the commits on each connection storage opens, to measure the write
// rate of a host (backend/conat/persist-write-rate).  The backend sets it; by
// default nothing is counted, and the persist diagnostics show write_stats
// null.  It lives in the backend because storage is in the browser bundle.
export type PersistStorageKind = "disk" | "ephemeral";
export interface PersistWriteCounter {
  // returns db (or db itself), counting its commits; takeRows returns the
  // messages the transaction in progress added and resets them
  wrap: (
    db: Database,
    kind: PersistStorageKind,
    takeRows: () => { rows: number; bytes: number },
  ) => Database;
  streamOpened: (kind: PersistStorageKind) => void;
  stats: () => Record<string, number>;
}
export let writeCounter: PersistWriteCounter | undefined = undefined;

// Records that make a disk-backed stream's durability survive this process
// (finding 028: DESIGN §3.2.5-§3.2.6), kept by the backend on tmpfs.  Keyed
// by the stream's logical id (its normalized path, never a resolved one).
// - arm: before any operation on the stream's files that can consume a sync
//   error (a write transaction, a checkpoint, a journal_mode switch), its
//   "dirty" record exists.  Throws if it can't be created: then the
//   operation must not start.
// - disarm: the stream is at a write idle and every commit since arm
//   returned OK, so the record is removed.
// - poison: a sync error was returned: the dirty record becomes the
//   poisoned-file record, so no later open in this boot serves the file.
//   Never throws.
// - check: at open.  "poisoned" refuses; "unverified" is a dirty record left
//   by another process (a crash mid-write): the outcome is unknown, so the
//   open is refused until it is verified (B-2 adds that path).
// Without it no disk-backed stream opens (fail closed).
// "leftover": only dirty records of DEAD processes (a crash mid-write): the
// outcome is unknown and a verified eviction settles it (B-2); "unverified":
// a live (or unknown) other process holds a record.
// "needs-check": poisoned in an earlier boot (the durable post-reboot
// record): opened only after a full integrity_check passes.
export type PersistDurabilityCheck =
  | "ok"
  | "poisoned"
  | "unverified"
  | "leftover"
  | "needs-check";
export interface PersistDurabilityRecords {
  arm: (id: string, owner?: string) => void;
  disarm: (id: string) => void;
  poison: (id: string, info: Record<string, string | number>) => void;
  // owner: the stream's logical owner (a project id, or "host"), if known: a
  // poisoned project refuses all of its streams (Q-F)
  check: (id: string, owner?: string) => PersistDurabilityCheck;
  poisonProject: (owner: string, info: Record<string, string | number>) => void;
  projectPoisonGeneration: (owner: string) => string | undefined;
  clearProjectPoison: (owner: string) => string[];
  // this process's generation
  generation?: string;
  // after a verified eviction: remove dead processes' dirty records
  clearLeftovers: (id: string) => number;
  // the ids an owner's dead processes left mid-write (undefined: unbounded
  // or unreadable, so not verifiable now)
  leftoverIdsOf: (owner: string, max?: number) => string[] | undefined;
  // after a passed integrity_check: remove the post-reboot record (durably;
  // throws on failure)
  clearPostReboot: (id: string) => void;
}
export let durability: PersistDurabilityRecords | undefined = undefined;

// The open barrier (finding 028, DESIGN §3.2.6): before a disk-backed stream
// serves anything, its -wal, .db and directory are fsync'd, with
// hostile-path checks (§3.1).  "discovery": an open/stat error or a check
// failed, nothing proven, retry; "sync-error": an fsync RETURNED an error, a
// durability signal (§3.2.3).  The backend sets it; without it no disk-backed
// stream opens (fail closed).
export type OpenBarrierResult =
  | { kind: "ok"; synced: string[] }
  | { kind: "discovery"; path: string; why: string }
  | { kind: "sync-error"; path: string; errno: string; synced: string[] };
export interface PersistOpenBarrier {
  // asynchronous (threadpool, capped, fair per owner): the persist server
  run: (dbPath: string, owner: string) => Promise<OpenBarrierResult>;
  // synchronous: in-process callers that construct a stream directly
  runSync: (dbPath: string) => OpenBarrierResult;
}
export let openBarrier: PersistOpenBarrier | undefined = undefined;

// Verified page-cache eviction (finding 028, DESIGN §3.2.6 H-b): for a stream
// a dead process left mid-write, make the page cache equal the disk (fsync,
// DONTNEED, mincore = 0, remove the -shm) before the normal open.  Anything
// unexpected is "not verified": the stream stays refused and is retried; it
// is never a poison.  The backend sets it; without it such streams stay
// refused.
export type VerifiedEvictionResult =
  | { verified: true; files: string[] }
  | { verified: false; path: string; why: string };
export let verifiedEviction:
  | ((dbPath: string) => Promise<VerifiedEvictionResult>)
  | undefined = undefined;

// A full PRAGMA integrity_check of a closed database, off the main thread, time
// bounded and one at a time per host (§3.2.6 POST-REBOOT, §3.2.9).  Without
// it, a stream with a post-reboot record stays refused.
// S-q (DESIGN §3.2.6): in a NEW persist process (no connection to the files
// exists), verify a project poisoned by a quota error at fsync: a trusted,
// bounded inventory of its store; for each file fsync, DONTNEED, mincore = 0,
// remove the -shm; then an integrity_check of each database.  Any failure:
// the project stays poisoned (no host effect).
export let projectRecovery:
  | ((
      owner: string,
      storeRoot: string,
    ) => Promise<{ ok: boolean; files?: string[]; why?: string }>)
  | undefined = undefined;

// The start-up preconditions of disk-stream service (028 B-3a: the records
// root on a per-boot tmpfs with safe ownership/mode, the NOFILE limit).  If
// they fail, disk-backed streams are refused with code
// "persist_unavailable"; ephemeral streams still run.  Without it, nothing
// is checked (in-browser and test contexts that set nothing else).
export let startupCheck: (() => { ok: boolean; reason?: string }) | undefined =
  undefined;

export let integrityCheck:
  | ((dbPath: string) => Promise<{ ok: boolean; why?: string }>)
  | undefined = undefined;

export let syncFiles = {
  local: "",
  localProjects: "",
  localAccounts: "",
  localHosts: "",
  localHub: "",
  archive: "",
  archiveInterval: 30_000,
  backup: "",
};

export let ensureContainingDirectoryExists: (path: string) => Promise<void> = (
  _path,
) => {
  throw Error("must initialize persist context");
};

export let statSync = (_path: string): { mtimeMs: number; size?: number } => {
  throw Error("must initialize persist context");
};

export let copyFileSync = (_src: string, _desc: string): void => {
  throw Error("must initialize persist context");
};

export function initContext(opts: {
  sqlite: { DatabaseSync: new (...args: any[]) => DatabaseSync };
  compress: (Buffer) => Buffer;
  decompress: (data: Buffer, maxOutputLength?: number) => Buffer;
  decompressAsync?: (data: Buffer, maxOutputLength?: number) => Promise<Buffer>;
  assertSafeDatabasePath?: (path: string) => void;
  isProjectOwnedDatabasePath?: (path: string) => boolean;
  syncFiles: {
    local: string;
    localProjects: string;
    localAccounts: string;
    localHosts: string;
    localHub: string;
    archive: string;
    archiveInterval: number;
    backup: string;
  };
  ensureContainingDirectoryExists: (path: string) => Promise<void>;
  statSync: (path: string) => { mtimeMs: number; size?: number };
  copyFileSync: (src: string, desc: string) => void;
  writeCounter?: PersistWriteCounter;
  durability?: PersistDurabilityRecords;
  openBarrier?: PersistOpenBarrier;
  verifiedEviction?: (dbPath: string) => Promise<VerifiedEvictionResult>;
  integrityCheck?: (dbPath: string) => Promise<{ ok: boolean; why?: string }>;
  startupCheck?: () => { ok: boolean; reason?: string };
  projectRecovery?: (
    owner: string,
    storeRoot: string,
  ) => Promise<{ ok: boolean; files?: string[]; why?: string }>;
}) {
  sqliteModule = opts.sqlite;
  compress = opts.compress;
  decompress = opts.decompress;
  decompressAsync =
    opts.decompressAsync ??
    (async (data: Buffer, maxOutputLength?: number) =>
      opts.decompress(data, maxOutputLength));
  assertSafeDatabasePath = opts.assertSafeDatabasePath ?? (() => {});
  isProjectOwnedDatabasePath = opts.isProjectOwnedDatabasePath ?? (() => false);
  syncFiles = opts.syncFiles;
  ensureContainingDirectoryExists = opts.ensureContainingDirectoryExists;
  statSync = opts.statSync;
  copyFileSync = opts.copyFileSync;
  writeCounter = opts.writeCounter;
  durability = opts.durability;
  openBarrier = opts.openBarrier;
  verifiedEviction = opts.verifiedEviction;
  integrityCheck = opts.integrityCheck;
  projectRecovery = opts.projectRecovery;
  startupCheck = opts.startupCheck;
}

export function createDatabase(...args): Database {
  if (sqliteModule == null) {
    throw Error(
      "conat/persist must be initialized with node:sqlite -- import from backend/conat/persist instead",
    );
  }
  return new sqliteModule.DatabaseSync(...args);
}
