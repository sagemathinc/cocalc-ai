/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The open boards on this project host, one BoardManager each.

A browser showing a board calls the filesystem service's boardOpen(path)
when it opens it and then every BOARD_LEASE_RENEW_MS while it shows it (a
lease). The board's host starts on the first call, and stops, after a final
save, once no call has come for BOARD_LEASE_MS. At the cap of
MAX_OPEN_BOARDS boards with one viewer each, renewals are about 7 calls a
second on the host. It lives on the always-on project-host data plane,
never in the project's compute container, so boards open and save while
compute is stopped. registry.ts keeps one manager per board, through its
close.
*/

import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { BoardOpenResult, Filesystem } from "@cocalc/conat/files/fs";
import { immerdb, type ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import { getLogger } from "@cocalc/backend/logger";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import { make_patch } from "@cocalc/util/dmp";
import {
  BOARD_EDITABLE_LIMIT,
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
  boardSyncdbPath,
  isBoardJsonPath,
} from "@cocalc/util/board/names";
import { BoardManager, type BoardFile, type BoardLib } from "./manager";
import {
  BoardRegistry,
  type BoardManagerLike,
  type StartedBoard,
} from "./registry";

const logger = getLogger("project-host:board");

const PROJECT_HOME = "/home/user";
export const BOARD_LEASE_MS = 90_000;
// What a client showing a board should renew its lease at.
export const BOARD_LEASE_RENEW_MS = 30_000;
const MAX_OPEN_BOARDS = 200;
const MAX_OPEN_BOARDS_PER_PROJECT = 20;
// A syncdb or a first load slower than this fails the start.
const START_STEP_TIMEOUT_MS = 45_000;

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

function isMissing(err: any): boolean {
  return err?.code === "ENOENT" || err?.code === "ENOTDIR";
}

// A write that lost its compare-and-swap: the file is not the expected text
// (or is gone).
function isConflict(err: any): boolean {
  return (
    err?.code === "ETAG_MISMATCH" ||
    err?.code === "PATCH_FAILED" ||
    /Mismatched base version|Failed to apply patch/.test(`${err?.message}`)
  );
}

export function fileOf(
  fs: Pick<Filesystem, "lstat" | "readFile" | "writeFile" | "watch">,
  path: string,
): BoardFile {
  return {
    info: async () => {
      try {
        const stats = await fs.lstat(path);
        return {
          size: stats.size,
          links: stats.nlink,
          symlink: (stats.mode & 0o170000) === 0o120000,
        };
      } catch (err: any) {
        if (isMissing(err)) return;
        throw err;
      }
    },
    read: async (): Promise<string | undefined> => {
      try {
        const value = await fs.readFile(path, "utf8");
        return typeof value === "string"
          ? value
          : Buffer.from(value).toString();
      } catch (err: any) {
        if (isMissing(err)) return;
        throw err;
      }
    },
    // The storage's conditional write: it applies the patch only if the
    // file's SHA-256 is expected's, writes a temp file and renames it over
    // the file, and never creates the file.
    replace: async (text: string, expected: string) => {
      try {
        await fs.writeFile(
          path,
          {
            patch: make_patch(expected, text),
            sha256: createHash("sha256").update(expected).digest("hex"),
          },
          true,
        );
        return "ok";
      } catch (err: any) {
        if (isConflict(err) || isMissing(err)) return "conflict";
        throw err;
      }
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

function timeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error(`${what} timed out`)), ms);
      (timer as any).unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

// Start a board's manager; on failure, nothing it started outlives the
// returned promise.
export async function startBoard({
  client,
  project_id,
  path,
  fs,
  service,
  manager: managerOptions,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Pick<Filesystem, "lstat" | "readFile" | "writeFile" | "watch">;
  service?: string;
  manager?: Partial<ConstructorParameters<typeof BoardManager>[0]>;
}): Promise<StartedBoard & { syncdb: ImmerDB }> {
  const lib = await loadBoardLib();
  const syncdb = await openBoardSyncdb({
    client,
    project_id,
    path,
    service,
    timeoutMs: START_STEP_TIMEOUT_MS,
  });
  const manager = new BoardManager({
    lib,
    syncdb: syncdb as any,
    file: fileOf(fs, path),
    recordsToString,
    log: (message, extra) => logger.debug(message, { path, ...extra }),
    ...managerOptions,
  });
  try {
    await timeout(manager.start(), START_STEP_TIMEOUT_MS, `loading ${path}`);
  } catch (err) {
    manager.revoke();
    await syncdb.close().catch(() => {});
    await manager.settled();
    throw err;
  }
  return { manager, syncdb, close: () => syncdb.close() };
}

// A board's live document. Browsers open it with the same options.
export async function openBoardSyncdb({
  client,
  project_id,
  path,
  service,
  timeoutMs,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  service?: string;
  timeoutMs?: number;
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
      const ready = new Promise<void>((resolve, reject) => {
        syncdb.once("ready", () => resolve());
        syncdb.once("error", reject);
      });
      await (timeoutMs == null
        ? ready
        : timeout(ready, timeoutMs, `opening the syncdb of ${path}`));
    } catch (err) {
      await syncdb.close().catch(() => {});
      throw err;
    }
  }
  return syncdb;
}

function result(
  path: string,
  manager: { getStatus: BoardManager["getStatus"] },
): BoardOpenResult {
  return {
    path,
    syncdbPath: boardSyncdbPath(path),
    ...manager.getStatus(),
  } as BoardOpenResult;
}

interface BoardRequest {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
  // The syncdb's file service (tests; the host's default otherwise).
  service?: string;
}

const registry = new BoardRegistry({
  leaseMs: BOARD_LEASE_MS,
  maxOpen: MAX_OPEN_BOARDS,
  maxPerGroup: MAX_OPEN_BOARDS_PER_PROJECT,
  log: (message, extra) => logger.debug(message, extra),
});

// The board's one name: symbolic links resolved (as sync identities are),
// so every alias of a board reaches the same manager and syncdb, whose
// target must itself be a board.
async function boardIdentity(opts: BoardRequest): Promise<string> {
  const path = canonicalBoardPath(opts.path);
  if (typeof opts.fs.canonicalSyncIdentityPath !== "function") return path;
  return canonicalBoardPath(await opts.fs.canonicalSyncIdentityPath(path));
}

type ManagerFor =
  | { path: string; manager: BoardManagerLike }
  | { path: string; status: BoardOpenResult };

async function managerFor(opts: BoardRequest): Promise<ManagerFor> {
  const path = await boardIdentity(opts);
  const key = `${opts.project_id}:${path}`;
  if (!registry.has(key)) {
    // Nothing to start for a file that is missing or too large: so such
    // paths take no slot and no memory.
    const info = await fileOf(opts.fs, path).info();
    if (info === undefined) {
      return { path, status: { ...boardPaths(path), state: "missing" } };
    }
    if (info.size > BOARD_EDITABLE_LIMIT) {
      return {
        path,
        status: {
          ...boardPaths(path),
          state: "too-large",
          bytes: info.size,
          message: `the board is ${info.size} bytes, over the ${BOARD_EDITABLE_LIMIT} a board can be edited at`,
        },
      };
    }
  }
  const manager = await registry.open(key, path, () =>
    startBoard({ ...opts, path }),
  );
  return { path, manager };
}

function boardPaths(path: string) {
  return { path, syncdbPath: boardSyncdbPath(path) };
}

export async function openBoard(opts: BoardRequest): Promise<BoardOpenResult> {
  const board = await managerFor(opts);
  if ("status" in board) return board.status;
  return result(board.path, board.manager);
}

export async function saveBoard(opts: BoardRequest): Promise<BoardOpenResult> {
  const board = await managerFor(opts);
  if ("status" in board) return board.status;
  await board.manager.save();
  return result(board.path, board.manager);
}

// Save and stop every open board (the host is stopping), or those of one
// project (it is stopping).
export async function closeBoards(project_id?: string): Promise<void> {
  await registry.closeAll(project_id == null ? "" : `${project_id}:`);
}

// For tests.
export function openBoardCount(): number {
  return registry.size();
}
export function sweepBoards(now?: number): void {
  registry.sweep(now);
}
