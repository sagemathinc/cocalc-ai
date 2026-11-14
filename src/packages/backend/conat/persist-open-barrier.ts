/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The open barrier of a disk-backed persist stream (finding 028, DESIGN v1.21
§3.2.6, §3.1).

Before a stream serves any read, dedupe or write, its files are fsync'd:
the existing -wal first, then the .db, then their directory once.  A file may
have been last written under synchronous=OFF (every file at the rollout, or a
process still on the old code), whose committed rows are only in the page
cache; without the barrier a new process would serve or dedupe them as if
durable.  An absent -wal means db-only; an absent .db means a new stream.

The fds opened here are short-lived and hostile-path checked (§3.1): no
symlink is followed (O_NOFOLLOW, and the lstat inode must equal the opened
fd's), only a regular file (or the directory) is accepted, and every file
must be on the .db's directory's device.  Any open/stat error or mismatch is a
DISCOVERY error: nothing is fsync'd on a foreign file, the stream is not
served, and the caller retries; it is never a poison (§3.2.1 E0).  An error
RETURNED BY fsync is a durability signal (§3.2.3): the caller poisons.

The asynchronous form runs the opens, stats and fsyncs in the libuv
threadpool, under a global concurrency cap with per-owner round-robin
fairness (§3.2.9), so a mass reopen cannot crowd out other owners.  The
synchronous form is for in-process callers that construct a stream directly;
the persist server always runs the asynchronous one first.
*/

import * as fs from "node:fs";
import { dirname } from "node:path";
import type {
  OpenBarrierResult,
  PersistOpenBarrier,
} from "@cocalc/conat/persist/context";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_DIRECTORY } = fs.constants;
const FILE_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK;
const DIR_FLAGS = O_RDONLY | O_NOFOLLOW | O_DIRECTORY;

// at most this many barrier jobs at once (DESIGN §3.2.9: default 8, at most
// 1/8 of the threadpool)
export const OPEN_BARRIER_CONCURRENCY = 8;

class Discovery extends Error {
  constructor(
    readonly path: string,
    readonly why: string,
  ) {
    super(`open barrier: ${why}: ${path}`);
  }
}

function errnoCode(err: unknown): string {
  return `${(err as NodeJS.ErrnoException)?.code ?? "EUNKNOWN"}`;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return a.ino === b.ino && a.dev === b.dev;
}

// ---------------------------------------------------------------------------
// synchronous form

function lstatSyncIfExists(path: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw new Discovery(path, `lstat ${errnoCode(err)}`);
  }
}

// fsync one checked file; returns its stats, or undefined if it is absent
function syncFileSync(
  path: string,
  dev: number | undefined,
  directory: boolean,
): { stats?: fs.Stats; syncError?: string } {
  const before = lstatSyncIfExists(path);
  if (before == null) return {};
  if (directory ? !before.isDirectory() : !before.isFile()) {
    throw new Discovery(path, "not a regular file or directory");
  }
  if (dev != null && before.dev !== dev) {
    throw new Discovery(path, "on another device");
  }
  let fd: number;
  try {
    fd = fs.openSync(path, directory ? DIR_FLAGS : FILE_FLAGS);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return {};
    throw new Discovery(path, `open ${errnoCode(err)}`);
  }
  try {
    let opened: fs.Stats;
    try {
      opened = fs.fstatSync(fd);
    } catch (err) {
      throw new Discovery(path, `fstat ${errnoCode(err)}`);
    }
    if (!sameFile(before, opened)) {
      throw new Discovery(path, "replaced between lstat and open");
    }
    try {
      fs.fsyncSync(fd);
    } catch (err) {
      return { stats: opened, syncError: errnoCode(err) };
    }
    return { stats: opened };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

export function openBarrierSync(dbPath: string): OpenBarrierResult {
  try {
    const dir = dirname(dbPath);
    const dirStats = lstatSyncIfExists(dir);
    if (dirStats == null) return { kind: "ok", synced: [] };
    if (!dirStats.isDirectory()) {
      throw new Discovery(dir, "not a directory");
    }
    const synced: string[] = [];
    for (const [path, directory] of [
      [`${dbPath}-wal`, false],
      [dbPath, false],
      [dir, true],
    ] as const) {
      const r = syncFileSync(path, dirStats.dev, directory);
      if (r.syncError != null) {
        return { kind: "sync-error", path, errno: r.syncError, synced };
      }
      if (r.stats != null) synced.push(path);
    }
    return { kind: "ok", synced };
  } catch (err) {
    if (err instanceof Discovery) {
      return { kind: "discovery", path: err.path, why: err.why };
    }
    return { kind: "discovery", path: dbPath, why: `${err}` };
  }
}

// ---------------------------------------------------------------------------
// asynchronous form

async function lstatIfExists(path: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.lstat(path);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw new Discovery(path, `lstat ${errnoCode(err)}`);
  }
}

async function syncFile(
  path: string,
  dev: number | undefined,
  directory: boolean,
): Promise<{ stats?: fs.Stats; syncError?: string }> {
  const before = await lstatIfExists(path);
  if (before == null) return {};
  if (directory ? !before.isDirectory() : !before.isFile()) {
    throw new Discovery(path, "not a regular file or directory");
  }
  if (dev != null && before.dev !== dev) {
    throw new Discovery(path, "on another device");
  }
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(path, directory ? DIR_FLAGS : FILE_FLAGS);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return {};
    throw new Discovery(path, `open ${errnoCode(err)}`);
  }
  try {
    let opened: fs.Stats;
    try {
      opened = await handle.stat();
    } catch (err) {
      throw new Discovery(path, `fstat ${errnoCode(err)}`);
    }
    if (!sameFile(before, opened)) {
      throw new Discovery(path, "replaced between lstat and open");
    }
    try {
      await handle.sync();
    } catch (err) {
      return { stats: opened, syncError: errnoCode(err) };
    }
    return { stats: opened };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function openBarrierJob(dbPath: string): Promise<OpenBarrierResult> {
  try {
    const dir = dirname(dbPath);
    const dirStats = await lstatIfExists(dir);
    if (dirStats == null) return { kind: "ok", synced: [] };
    if (!dirStats.isDirectory()) {
      throw new Discovery(dir, "not a directory");
    }
    const synced: string[] = [];
    // in order: the WAL, then the db, then the directory (§3.2.6, review R6)
    for (const [path, directory] of [
      [`${dbPath}-wal`, false],
      [dbPath, false],
      [dir, true],
    ] as const) {
      const r = await syncFile(path, dirStats.dev, directory);
      if (r.syncError != null) {
        return { kind: "sync-error", path, errno: r.syncError, synced };
      }
      if (r.stats != null) synced.push(path);
    }
    return { kind: "ok", synced };
  } catch (err) {
    if (err instanceof Discovery) {
      return { kind: "discovery", path: err.path, why: err.why };
    }
    return { kind: "discovery", path: dbPath, why: `${err}` };
  }
}

// A concurrency cap with round-robin fairness across owners (a project, or
// "host" for host-owned streams): owners take turns, one job each, so one
// owner's many streams wait behind each other, not in front of everybody
// else's.
export function createFairLimiter(limit: number) {
  let running = 0;
  const queues = new Map<string, Array<() => void>>();
  // owners with waiting jobs, in turn order
  const order: string[] = [];
  const pump = () => {
    while (running < limit && order.length > 0) {
      const owner = order.shift()!;
      const queue = queues.get(owner)!;
      const start = queue.shift()!;
      if (queue.length === 0) {
        queues.delete(owner);
      } else {
        order.push(owner); // its next job waits for the others' turn
      }
      running += 1;
      start();
    }
  };
  const run = <T>(owner: string, job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        job()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            pump();
          });
      };
      let queue = queues.get(owner);
      if (queue == null) {
        queue = [];
        queues.set(owner, queue);
        order.push(owner);
      }
      queue.push(start);
      pump();
    });
  return {
    run,
    stats: () => ({
      running,
      waiting: [...queues.values()].reduce((n, q) => n + q.length, 0),
    }),
  };
}

const limiter = createFairLimiter(OPEN_BARRIER_CONCURRENCY);

export function openBarrier(
  dbPath: string,
  owner: string,
): Promise<OpenBarrierResult> {
  return limiter.run(owner, () => openBarrierJob(dbPath));
}

export function openBarrierStats() {
  return limiter.stats();
}

export const persistOpenBarrier: PersistOpenBarrier = {
  run: openBarrier,
  runSync: openBarrierSync,
};
