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
}

export function createDatabase(...args): Database {
  if (sqliteModule == null) {
    throw Error(
      "conat/persist must be initialized with node:sqlite -- import from backend/conat/persist instead",
    );
  }
  return new sqliteModule.DatabaseSync(...args);
}
