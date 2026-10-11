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

export let decompress: (data: Buffer) => Buffer = () => {
  throw Error("must initialize persist context");
};

// Decompression that runs off the event loop (e.g., in the libuv threadpool),
// used for large messages so one huge stored message cannot stall every other
// stream served by the same process.  Defaults to the synchronous version.
export let decompressAsync: (data: Buffer) => Promise<Buffer> = async (data) =>
  decompress(data);

// Keep a copy of a stream's database, e.g., before its history is reset
// because it holds a message too large to read.  Returns the copy's path, or
// undefined if archiving is not supported here.
export let archiveDatabase: (
  db: Database,
  dbPath: string,
) => Promise<string | undefined> = async () => undefined;

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
  decompress: (Buffer) => Buffer;
  decompressAsync?: (Buffer) => Promise<Buffer>;
  archiveDatabase?: (
    db: Database,
    dbPath: string,
  ) => Promise<string | undefined>;
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
    opts.decompressAsync ?? (async (data: Buffer) => opts.decompress(data));
  archiveDatabase = opts.archiveDatabase ?? (async () => undefined);
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
