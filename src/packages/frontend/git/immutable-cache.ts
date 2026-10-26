/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A cache for Git output that can never change: reads named only by full
// object ids (a commit's summary, parents, changed files and patch; a blob;
// the history below a commit). Kept in this browser (IndexedDB) so flipping
// back to a commit, or opening it again after a reload, needs no round trip
// to the project. Least recently used entries go first once over budget.
// Any storage error is a miss: the cache never breaks a read.

export interface ImmutableGitCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
}

export const GIT_CACHE_BUDGET_BYTES = 100_000_000;
/** Values larger than this are not kept (a single huge patch). */
export const GIT_CACHE_MAX_ENTRY_BYTES = 8_000_000;

const bytesOf = (value: string) => value.length * 2;

export type CacheEntryMeta = { key: string; bytes: number; used: number };

/** Which entries to drop, least recently used first, to fit the budget. */
export function evictionOrder(
  entries: CacheEntryMeta[],
  budget: number,
): string[] {
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const drop: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.used - b.used)) {
    if (total <= budget) break;
    drop.push(entry.key);
    total -= entry.bytes;
  }
  return drop;
}

/** In memory only: tests, and browsers without IndexedDB. */
export class MemoryGitCache implements ImmutableGitCache {
  private entries = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly budget = 16_000_000) {}

  async get(key: string): Promise<string | undefined> {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    const bytes = bytesOf(value);
    if (bytes > Math.min(this.budget, GIT_CACHE_MAX_ENTRY_BYTES)) return;
    const old = this.entries.get(key);
    if (old !== undefined) {
      this.bytes -= bytesOf(old);
      this.entries.delete(key);
    }
    while (this.entries.size && this.bytes + bytes > this.budget) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= bytesOf(this.entries.get(oldest)!);
      this.entries.delete(oldest);
    }
    this.entries.set(key, value);
    this.bytes += bytes;
  }
}

const DB_NAME = "cocalc-git-read-cache";
const VALUES = "values";
const META = "meta";

const done = (request: IDBRequest) =>
  new Promise<any>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** In this browser, across reloads, within a byte budget. */
export class IndexedDbGitCache implements ImmutableGitCache {
  private db?: Promise<IDBDatabase | undefined>;
  private pruneTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly budget = GIT_CACHE_BUDGET_BYTES,
    private readonly name = DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase | undefined> {
    this.db ??= new Promise((resolve) => {
      try {
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore(VALUES);
          request.result.createObjectStore(META);
        };
        request.onsuccess = () => resolve(request.result);
        // Private browsing, quota, an old schema: work without it.
        request.onerror = () => resolve(undefined);
        request.onblocked = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
    return this.db;
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const db = await this.open();
      if (!db) return undefined;
      const tx = db.transaction([VALUES, META], "readwrite");
      const value = await done(tx.objectStore(VALUES).get(key));
      if (typeof value !== "string") return undefined;
      // Recently used: kept longest.
      tx.objectStore(META).put(
        { key, bytes: bytesOf(value), used: Date.now() },
        key,
      );
      return value;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const bytes = bytesOf(value);
    if (bytes > GIT_CACHE_MAX_ENTRY_BYTES) return;
    try {
      const db = await this.open();
      if (!db) return;
      const tx = db.transaction([VALUES, META], "readwrite");
      tx.objectStore(VALUES).put(value, key);
      tx.objectStore(META).put({ key, bytes, used: Date.now() }, key);
      await committed(tx);
      this.schedulePrune();
    } catch {
      // A full disk is a miss next time, not an error now.
    }
  }

  private schedulePrune(): void {
    if (this.pruneTimer != null) return;
    this.pruneTimer = setTimeout(() => {
      this.pruneTimer = undefined;
      void this.prune();
    }, 2_000);
  }

  /** Drop least recently used entries until within the budget. */
  async prune(): Promise<void> {
    try {
      const db = await this.open();
      if (!db) return;
      const meta: CacheEntryMeta[] = await done(
        db.transaction(META, "readonly").objectStore(META).getAll(),
      );
      const drop = evictionOrder(meta, this.budget);
      if (!drop.length) return;
      const tx = db.transaction([VALUES, META], "readwrite");
      for (const key of drop) {
        tx.objectStore(VALUES).delete(key);
        tx.objectStore(META).delete(key);
      }
      await committed(tx);
    } catch {
      // Tried again after the next write.
    }
  }
}

/** IndexedDB in browsers, memory elsewhere. */
export function defaultGitCache(): ImmutableGitCache {
  return typeof indexedDB === "undefined"
    ? new MemoryGitCache()
    : new IndexedDbGitCache();
}
