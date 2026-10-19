/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The open boards on this project host, one BoardManager each.

A browser showing a board calls the filesystem service's boardOpen(path)
when it opens it and then every so often while it shows it (a lease). The
board's host starts on the first call, and stops, after a final save, once
no call has come for BOARD_LEASE_MS. It lives on the always-on project-host
data plane, never in the project's compute container, so boards open and
save while compute is stopped.
*/

import { posix } from "node:path";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { BoardOpenResult, Filesystem } from "@cocalc/conat/files/fs";
import { immerdb, type ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import { getLogger } from "@cocalc/backend/logger";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
  boardSyncdbPath,
  isBoardJsonPath,
} from "@cocalc/util/board/names";
import { BoardManager, type BoardLib } from "./manager";

const logger = getLogger("project-host:board");

const PROJECT_HOME = "/home/user";
export const BOARD_LEASE_MS = 90_000;
const SWEEP_MS = 30_000;
const MAX_OPEN_BOARDS = 200;

let libPromise: Promise<BoardLib> | undefined;
// @sagemathinc/sagebrush-board is ESM; Node loads it through require() once
// its exports offer "default" (0.3.0).
export function loadBoardLib(): Promise<BoardLib> {
  libPromise ??= import("@sagemathinc/sagebrush-board") as Promise<any>;
  return libPromise;
}

// The syncdb's string for a list of records, as its own documents make it.
export function recordsToString(records: any[]): string {
  let doc: any = immerFromStr("", BOARD_PRIMARY_KEYS, BOARD_STRING_COLS);
  for (const record of records) doc = doc.set(record);
  return doc.to_str();
}

// The board's path as every client names it: absolute, normalized.
export function canonicalBoardPath(path: string): string {
  const value = `${path ?? ""}`.trim();
  if (!value) throw Error("board path must be nonempty");
  const abs = posix.isAbsolute(value)
    ? posix.normalize(value)
    : posix.resolve(PROJECT_HOME, value);
  if (!isBoardJsonPath(abs)) {
    throw Error(`not a board: ${abs} (a board's name ends in .board.json)`);
  }
  return abs;
}

interface Entry {
  key: string;
  path: string;
  ready: Promise<{ manager: BoardManager; syncdb: ImmerDB }>;
  lastSeen: number;
}

const boards = new Map<string, Entry>();
let sweeper: ReturnType<typeof setInterval> | undefined;

export function fileOf(
  fs: Pick<Filesystem, "readFile" | "writeFile" | "watch">,
  path: string,
) {
  return {
    read: async (): Promise<string | undefined> => {
      try {
        const value = await fs.readFile(path, "utf8");
        return typeof value === "string"
          ? value
          : Buffer.from(value).toString();
      } catch (err: any) {
        if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return;
        throw err;
      }
    },
    write: async (text: string) => {
      await fs.writeFile(path, text);
    },
    watch: (onChange: () => void) => {
      let stopped = false;
      let iterator: any;
      void (async () => {
        try {
          iterator = await fs.watch(path);
          if (stopped) {
            iterator?.end?.();
            return;
          }
          for await (const _event of iterator) {
            if (stopped) break;
            onChange();
          }
        } catch (err) {
          if (!stopped) logger.debug("board watch ended", { path, err });
        }
      })();
      return () => {
        stopped = true;
        iterator?.end?.();
        iterator?.close?.();
      };
    },
  };
}

async function startBoard({
  client,
  project_id,
  path,
  fs,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
}): Promise<{ manager: BoardManager; syncdb: ImmerDB }> {
  const lib = await loadBoardLib();
  const syncdb = await openBoardSyncdb({ client, project_id, path });
  try {
    const manager = new BoardManager({
      lib,
      syncdb: syncdb as any,
      file: fileOf(fs, path),
      recordsToString,
      log: (message, extra) => logger.debug(message, { path, ...extra }),
    });
    await manager.start();
    return { manager, syncdb };
  } catch (err) {
    await syncdb.close().catch(() => {});
    throw err;
  }
}

// A board's live document. Browsers open it with the same options.
export async function openBoardSyncdb({
  client,
  project_id,
  path,
  service,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  service?: string;
}): Promise<ImmerDB> {
  const syncdb = immerdb({
    client,
    project_id,
    service,
    path: boardSyncdbPath(path),
    primary_keys: BOARD_PRIMARY_KEYS,
    string_cols: BOARD_STRING_COLS,
    change_throttle: 50,
    patch_interval: 50,
    cursors: false,
    persistent: true,
    // The board's only file is its .board.json, which the manager writes.
    noSaveToDisk: true,
  });
  if (!syncdb.isReady()) {
    try {
      await new Promise<void>((resolve, reject) => {
        syncdb.once("ready", () => resolve());
        syncdb.once("error", reject);
      });
    } catch (err) {
      await syncdb.close().catch(() => {});
      throw err;
    }
  }
  return syncdb;
}

function result(path: string, manager: BoardManager): BoardOpenResult {
  const status = manager.getStatus();
  return {
    path,
    syncdbPath: boardSyncdbPath(path),
    ...status,
  } as BoardOpenResult;
}

async function stopEntry(entry: Entry): Promise<void> {
  boards.delete(entry.key);
  try {
    const { manager, syncdb } = await entry.ready;
    await manager.close();
    await syncdb.close();
  } catch (err) {
    logger.debug("stopping a board failed", { path: entry.path, err });
  }
}

function sweep(now = Date.now()): void {
  for (const entry of [...boards.values()]) {
    if (now - entry.lastSeen > BOARD_LEASE_MS) void stopEntry(entry);
  }
  if (boards.size === 0 && sweeper != null) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function getEntry(opts: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
}): Entry {
  const path = canonicalBoardPath(opts.path);
  const key = `${opts.project_id}:${path}`;
  let entry = boards.get(key);
  if (entry == null) {
    if (boards.size >= MAX_OPEN_BOARDS) {
      throw Error(`too many open boards on this host (${MAX_OPEN_BOARDS})`);
    }
    entry = {
      key,
      path,
      lastSeen: Date.now(),
      ready: startBoard({ ...opts, path }),
    };
    const started = entry;
    boards.set(key, started);
    started.ready.catch(() => {
      if (boards.get(key) === started) boards.delete(key);
    });
    sweeper ??= setInterval(sweep, SWEEP_MS);
    (sweeper as any).unref?.();
  }
  entry.lastSeen = Date.now();
  return entry;
}

export async function openBoard(opts: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
}): Promise<BoardOpenResult> {
  const entry = getEntry(opts);
  const { manager } = await entry.ready;
  return result(entry.path, manager);
}

export async function saveBoard(opts: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
}): Promise<BoardOpenResult> {
  const entry = getEntry(opts);
  const { manager } = await entry.ready;
  await manager.save();
  return result(entry.path, manager);
}

// Save and stop every open board (the host is stopping), or those of one
// project (it is stopping).
export async function closeBoards(project_id?: string): Promise<void> {
  await Promise.all(
    [...boards.values()]
      .filter(
        (entry) => project_id == null || entry.key.startsWith(`${project_id}:`),
      )
      .map(stopEntry),
  );
}

// For tests.
export function openBoardCount(): number {
  return boards.size;
}
export function sweepBoards(now?: number): void {
  sweep(now);
}
