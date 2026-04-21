/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { uuid } from "@cocalc/util/misc";

export type BrowserOutboxKind = "chat-row" | "dkv" | "dstream";
export type BrowserOutboxOperation = "chat-row" | "set" | "delete" | "publish";

export type BrowserOutboxEntry<T = unknown> = {
  id: string;
  kind: BrowserOutboxKind;
  schema_version: 1;
  created_at: number;
  updated_at: number;
  expires_at: number;
  last_attempt_at?: number;
  account_id?: string;
  project_id?: string;
  host_id?: string;
  name?: string;
  path?: string;
  key?: string;
  msgID?: string;
  operation_id?: string;
  op: BrowserOutboxOperation;
  payload?: T;
  label?: string;
  description?: string;
  preview?: string;
  bytes: number;
  lease_owner?: string;
  lease_expires_at?: number;
};

export type BrowserOutboxPutOptions<T = unknown> = Omit<
  Partial<BrowserOutboxEntry<T>>,
  "schema_version" | "created_at" | "updated_at" | "expires_at" | "bytes"
> & {
  kind: BrowserOutboxKind;
  op: BrowserOutboxOperation;
  created_at?: number;
  expires_at?: number;
  ttlMs?: number;
  maxEntryBytes?: number;
};

export type BrowserOutboxListQuery = {
  kind?: BrowserOutboxKind;
  account_id?: string;
  project_id?: string;
  path?: string;
  name?: string;
};

export type BrowserOutboxLimits = {
  ttlMs: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxEntries: number;
};

export const DEFAULT_BROWSER_OUTBOX_LIMITS: BrowserOutboxLimits = {
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxEntryBytes: 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxEntries: 10_000,
};

export interface BrowserOutboxBackend {
  listAll(): Promise<BrowserOutboxEntry[]>;
  put(entry: BrowserOutboxEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

function estimateBytes(value: unknown): number {
  if (value == null) return 0;
  if (value instanceof Uint8Array) return value.byteLength;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = `${value}`;
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

function matchesQuery(
  entry: BrowserOutboxEntry,
  query?: BrowserOutboxListQuery,
) {
  if (!query) return true;
  for (const key of [
    "kind",
    "account_id",
    "project_id",
    "path",
    "name",
  ] as const) {
    if (query[key] != null && entry[key] !== query[key]) return false;
  }
  return true;
}

function sortOldestFirst(entries: BrowserOutboxEntry[]): BrowserOutboxEntry[] {
  return [...entries].sort((a, b) => {
    const created = a.created_at - b.created_at;
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
}

export class BrowserOutboxStore {
  private backend: BrowserOutboxBackend;
  private limits: BrowserOutboxLimits;

  constructor({
    backend,
    limits,
  }: {
    backend: BrowserOutboxBackend;
    limits?: Partial<BrowserOutboxLimits>;
  }) {
    this.backend = backend;
    this.limits = { ...DEFAULT_BROWSER_OUTBOX_LIMITS, ...(limits ?? {}) };
  }

  async put<T>(
    opts: BrowserOutboxPutOptions<T>,
  ): Promise<BrowserOutboxEntry<T> | undefined> {
    const now = Date.now();
    const bytes = estimateBytes(opts);
    const {
      ttlMs,
      maxEntryBytes: explicitMaxEntryBytes,
      created_at,
      expires_at,
      ...entryOptions
    } = opts;
    const maxEntryBytes = explicitMaxEntryBytes ?? this.limits.maxEntryBytes;
    if (bytes > maxEntryBytes) {
      return undefined;
    }
    const entry: BrowserOutboxEntry<T> = {
      ...(entryOptions as Omit<BrowserOutboxEntry<T>, "schema_version">),
      id: opts.id ?? uuid(),
      schema_version: 1,
      created_at: created_at ?? now,
      updated_at: now,
      expires_at: expires_at ?? now + (ttlMs ?? this.limits.ttlMs),
      bytes,
    };
    await this.backend.put(entry as BrowserOutboxEntry);
    await this.cleanup();
    return entry;
  }

  async list<T = unknown>(
    query?: BrowserOutboxListQuery,
  ): Promise<BrowserOutboxEntry<T>[]> {
    await this.cleanupExpired();
    const entries = await this.backend.listAll();
    return sortOldestFirst(entries)
      .filter((entry) => matchesQuery(entry, query))
      .map((entry) => entry as BrowserOutboxEntry<T>);
  }

  async get<T = unknown>(
    id: string,
  ): Promise<BrowserOutboxEntry<T> | undefined> {
    const entries = await this.backend.listAll();
    return entries.find((entry) => entry.id === id) as
      | BrowserOutboxEntry<T>
      | undefined;
  }

  async remove(id: string): Promise<void> {
    await this.backend.delete(id);
  }

  async acquireLease<T = unknown>({
    id,
    owner,
    ttlMs = 30_000,
  }: {
    id: string;
    owner: string;
    ttlMs?: number;
  }): Promise<BrowserOutboxEntry<T> | undefined> {
    const now = Date.now();
    const entry = await this.get<T>(id);
    if (!entry) return undefined;
    if (
      entry.lease_owner &&
      entry.lease_owner !== owner &&
      (entry.lease_expires_at ?? 0) > now
    ) {
      return undefined;
    }
    const leased: BrowserOutboxEntry<T> = {
      ...entry,
      lease_owner: owner,
      lease_expires_at: now + ttlMs,
      last_attempt_at: now,
      updated_at: now,
    };
    await this.backend.put(leased as BrowserOutboxEntry);
    return leased;
  }

  async cleanup(): Promise<void> {
    await this.cleanupExpired();
    await this.enforceCaps();
  }

  private async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const entries = await this.backend.listAll();
    await Promise.all(
      entries
        .filter((entry) => entry.expires_at <= now)
        .map((entry) => this.backend.delete(entry.id)),
    );
  }

  private async enforceCaps(): Promise<void> {
    const entries = sortOldestFirst(await this.backend.listAll());
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let count = entries.length;
    for (const entry of entries) {
      if (
        totalBytes <= this.limits.maxTotalBytes &&
        count <= this.limits.maxEntries
      ) {
        break;
      }
      await this.backend.delete(entry.id);
      totalBytes -= entry.bytes;
      count -= 1;
    }
  }
}

export class MemoryBrowserOutboxBackend implements BrowserOutboxBackend {
  private entries = new Map<string, BrowserOutboxEntry>();

  async listAll(): Promise<BrowserOutboxEntry[]> {
    return Array.from(this.entries.values()).map((entry) => ({ ...entry }));
  }

  async put(entry: BrowserOutboxEntry): Promise<void> {
    this.entries.set(entry.id, { ...entry });
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

export class IndexedDBBrowserOutboxBackend implements BrowserOutboxBackend {
  private dbName: string;
  private dbPromise?: Promise<IDBDatabase>;

  constructor(dbName = "cocalc-conat-outbox-v1") {
    this.dbName = dbName;
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    if (typeof indexedDB === "undefined") {
      return Promise.reject(new Error("indexedDB is not available"));
    }
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.createObjectStore("entries", { keyPath: "id" });
        store.createIndex("byIdentity", ["kind", "project_id", "path"]);
        store.createIndex("byProjectPath", ["project_id", "path"]);
        store.createIndex("byCreatedAt", "created_at");
        store.createIndex("byExpiresAt", "expires_at");
      };
      request.onsuccess = () => resolve(request.result);
    });
    return this.dbPromise;
  }

  private async withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    const db = await this.open();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction("entries", mode);
      const store = tx.objectStore("entries");
      let request: IDBRequest<T> | void;
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      try {
        request = fn(store);
      } catch (err) {
        reject(err);
      }
    });
  }

  async listAll(): Promise<BrowserOutboxEntry[]> {
    return (
      (await this.withStore<BrowserOutboxEntry[]>("readonly", (store) =>
        store.getAll(),
      )) ?? []
    );
  }

  async put(entry: BrowserOutboxEntry): Promise<void> {
    await this.withStore("readwrite", (store) => store.put(entry));
  }

  async delete(id: string): Promise<void> {
    await this.withStore("readwrite", (store) => store.delete(id));
  }
}

let defaultBrowserOutbox: BrowserOutboxStore | undefined;

export function getBrowserOutbox(): BrowserOutboxStore | undefined {
  if (defaultBrowserOutbox) return defaultBrowserOutbox;
  if (typeof indexedDB === "undefined") return undefined;
  defaultBrowserOutbox = new BrowserOutboxStore({
    backend: new IndexedDBBrowserOutboxBackend(),
  });
  return defaultBrowserOutbox;
}

export function setDefaultBrowserOutboxForTests(
  store: BrowserOutboxStore | undefined,
): void {
  defaultBrowserOutbox = store;
}
