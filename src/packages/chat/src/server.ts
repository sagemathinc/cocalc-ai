/**
 * Lightweight manager for chat SyncDB instances.
 *
 * - Provides createChatSyncDB with sane defaults for chats.
 * - Maintains a ref-counted pool so a given project/path SyncDB is opened only once
 *   in this process, and reused across turns.
 * - Delays closing for a short interval to keep the connection warm, but cancels
 *   a pending close immediately if a new acquire arrives (avoids long stalls).
 */
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  immerdb,
  type ImmerDBOptions,
  type ImmerDB,
} from "@cocalc/conat/sync-doc/immer-db";
import { RefcountLeaseManager } from "@cocalc/util/refcount/lease";
import { getLogger } from "@cocalc/conat/logger";
import { posix as path } from "node:path";

const logger = getLogger("chat:server");
const PROJECT_HOME = "/home/user";

export type { ImmerDB };

export function canonicalChatPath(chatPath: string): string {
  const value = `${chatPath ?? ""}`.trim();
  if (!value) {
    throw new Error("chat path must be nonempty");
  }
  return path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(PROJECT_HOME, value);
}

// Keep legacy keys first, but include v2 identity keys so we can do indexed
// lookups by message_id/thread_id without O(n) scans.
export const CHAT_PRIMARY_KEYS = [
  "date",
  "sender_id",
  "event",
  "message_id",
  "thread_id",
];
export const CHAT_STRING_COLS = ["input"];

export interface CreateChatSyncDBOptions extends Omit<
  ImmerDBOptions,
  "primary_keys" | "path" | "project_id" | "client"
> {
  client: ConatClient;
  project_id: string;
  path: string;
  readyTimeoutMs?: number;
}

export function createChatSyncDB(opts: CreateChatSyncDBOptions): ImmerDB {
  const {
    client,
    project_id,
    path,
    change_throttle,
    patch_interval,
    string_cols,
    cursors,
    persistent,
    readyTimeoutMs: _readyTimeoutMs,
    ...rest
  } = opts;

  const options: ImmerDBOptions = {
    ...rest,
    client,
    project_id,
    path: canonicalChatPath(path),
    primary_keys: CHAT_PRIMARY_KEYS,
    string_cols: string_cols ?? CHAT_STRING_COLS,
    change_throttle: change_throttle ?? 50,
    patch_interval: patch_interval ?? 50,
    cursors: cursors ?? true,
    persistent: persistent ?? true,
  };

  return immerdb(options);
}

// Ref-counted pool using RefcountLeaseManager so a given project/path syncdb is opened once.
const CLOSE_DELAY_MS = 30_000;
const openSyncdbs = new Map<string, ImmerDB>();
const leases = new RefcountLeaseManager<string>({
  delayMs: CLOSE_DELAY_MS,
  disposer: async (key: string) => {
    const db = openSyncdbs.get(key);
    if (!db) return;
    try {
      await db.close();
      logger.debug("closed syncdb", { key });
    } catch (err) {
      logger.debug("close syncdb failed", { key, err });
    } finally {
      openSyncdbs.delete(key);
    }
  },
});
const leaseReleases: Map<string, Array<() => Promise<void>>> = new Map();

function poolKey(project_id: string, path: string): string {
  return `${project_id}:${canonicalChatPath(path)}`;
}

function pushRelease(key: string, release: () => Promise<void>) {
  const arr = leaseReleases.get(key);
  if (arr) {
    arr.push(release);
  } else {
    leaseReleases.set(key, [release]);
  }
}

function popRelease(key: string): (() => Promise<void>) | undefined {
  const arr = leaseReleases.get(key);
  if (!arr) return undefined;
  const rel = arr.pop();
  if (arr.length === 0) {
    leaseReleases.delete(key);
  }
  return rel;
}

export async function acquireChatSyncDB(
  opts: CreateChatSyncDBOptions,
): Promise<ImmerDB> {
  const key = poolKey(opts.project_id, opts.path);
  const release = await leases.acquire(key);
  const existing = openSyncdbs.get(key);
  if (existing) {
    pushRelease(key, release);
    return existing;
  }
  logger.debug("acquireChatSyncDB: create new", { key });
  const db = createChatSyncDB(opts);
  try {
    await waitForChatSyncDBReady(db, {
      key,
      timeoutMs: opts.readyTimeoutMs,
    });
    openSyncdbs.set(key, db);
    pushRelease(key, release);
    return db;
  } catch (err) {
    try {
      await db.close();
    } catch (closeErr) {
      logger.debug("close failed after syncdb acquisition error", {
        key,
        err: closeErr,
      });
    }
    await release();
    throw err;
  }
}

async function waitForChatSyncDBReady(
  db: ImmerDB,
  { key, timeoutMs }: { key: string; timeoutMs?: number },
): Promise<void> {
  if (db.isReady()) return;
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      db.removeListener("ready", onReady);
      db.removeListener("error", onError);
      if (timer != null) clearTimeout(timer);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err);
    };
    db.once("ready", onReady);
    db.once("error", onError);
    if (Number.isFinite(timeoutMs) && (timeoutMs ?? 0) > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out waiting for chat SyncDB '${key}' after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

export async function releaseChatSyncDB(
  project_id: string,
  path: string,
): Promise<void> {
  const key = poolKey(project_id, path);
  const release = popRelease(key);
  if (!release) return;
  await release();
}
