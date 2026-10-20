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

// With maxOutputLength, decompression stops (throws) before producing more
// than that many bytes: what a compressed message inflates to is never
// allocated past it.
export interface DecompressOptions {
  maxOutputLength?: number;
}

export let decompress: (
  data: Buffer,
  opts?: DecompressOptions,
) => Buffer = () => {
  throw Error("must initialize persist context");
};

// Decompression that runs off the event loop (e.g., in the libuv threadpool),
// used for large messages so one huge stored message cannot stall every other
// stream served by the same process.  Defaults to the synchronous version.
export let decompressAsync: (
  data: Buffer,
  opts?: DecompressOptions,
) => Promise<Buffer> = async (data, opts) => decompress(data, opts);

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
  decompress: (data: Buffer, opts?: DecompressOptions) => Buffer;
  decompressAsync?: (data: Buffer, opts?: DecompressOptions) => Promise<Buffer>;
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
    (async (data: Buffer, o?: DecompressOptions) => opts.decompress(data, o));
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
