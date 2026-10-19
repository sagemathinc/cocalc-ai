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

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type { BoardOpenResult, Filesystem } from "@cocalc/conat/files/fs";
import { immerdb, type ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import { getLogger } from "@cocalc/backend/logger";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import {
  BOARD_EDITABLE_LIMIT,
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
  boardSyncdbPath,
  isBoardJsonPath,
} from "@cocalc/util/board/names";
import {
  BoardManager,
  type BoardFile,
  type BoardLib,
  type BoardRead,
} from "./manager";
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
// Built in one pass (a set per record copies the document each time,
// quadratic for a large board).
export function recordsToString(records: any[]): string {
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  return immerFromStr(lines, BOARD_PRIMARY_KEYS, BOARD_STRING_COLS).to_str();
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

// SandboxedFilesystem's bounded read, which the project host's file
// service hands the board handlers (it is not on the RPC surface).
type BoundedReadFilesystem = {
  readRegularFileAuthorized?: (opts: {
    path: string;
    authorizeCanonicalIdentity: (identity: string) => void;
    maxBytes: number;
    encoding?: string;
  }) => Promise<string | Buffer>;
};

type BoardFilesystem = Pick<
  Filesystem,
  | "lstat"
  | "readFile"
  | "writeFile"
  | "watch"
  | "rename"
  | "move"
  | "unlink"
  | "chmod"
  | "readdir"
> &
  BoundedReadFilesystem;

async function readBoundedText(
  fs: BoundedReadFilesystem,
  path: string,
  maxBytes: number,
  authorizeCanonicalIdentity: (identity: string) => void = () => {},
): Promise<string> {
  const readAuthorized = fs.readRegularFileAuthorized;
  if (typeof readAuthorized !== "function") {
    throw Error("boards require the sandbox's bounded reads");
  }
  const value = await readAuthorized.call(fs, {
    path,
    maxBytes: Math.max(1, maxBytes),
    encoding: "utf8",
    authorizeCanonicalIdentity,
  });
  return `${value}`;
}

function isExists(err: any): boolean {
  return err?.code === "EEXIST" || /already exists/i.test(`${err?.message}`);
}

// Is the file at p exactly text? Reads at most text's size + 1 bytes.
async function holdsExactly(
  fs: BoardFilesystem,
  p: string,
  text: string,
): Promise<boolean> {
  try {
    return (await readBoundedText(fs, p, Buffer.byteLength(text))) === text;
  } catch (err: any) {
    if (isMissing(err) || err?.code === "EFBIG" || err?.code === "EACCES") {
      return false;
    }
    throw err;
  }
}

// Test hooks: run in the windows between replaceBoardFile's steps.
export interface ReplaceHooks {
  afterAside?: () => Promise<void>;
  afterVerify?: () => Promise<void>;
  afterPlace?: () => Promise<void>;
}

function sidePath(path: string, id: string, kind: "tmp" | "aside"): string {
  return posix.join(
    posix.dirname(path),
    `.${posix.basename(path)}.${id}.sage-board-${kind}`,
  );
}

function conflictPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.conflict-${stamp}-${randomUUID().slice(0, 8)}`;
}

// Move a version of the board aside from p to a place nobody overwrites:
// back to path if path is free, else a conflict copy beside it.
async function keepVersion(fs: BoardFilesystem, p: string, path: string) {
  try {
    await fs.move(p, path, { overwrite: false });
    return;
  } catch (err) {
    if (!isExists(err)) throw err;
  }
  const copy = conflictPath(path);
  await fs.move(p, copy, { overwrite: false });
  logger.warn("board: kept another writer's version as a conflict copy", {
    path,
    copy,
  });
}

/*
Replace the board's file with text, only if it is exactly expected, so that
no other writer's version is ever written over or deleted:

1. text goes to a temp file beside the board;
2. the board is renamed aside (atomic: whatever is there at that instant,
   from anyone, is now in the aside file; a missing file is a conflict and
   is not created);
3. the aside file must be exactly expected, or it goes back (and the save
   is a conflict);
4. the temp file is renamed to the board's name only if nothing is there
   (the sandbox's renameNoReplace, an atomic RENAME_NOREPLACE): a file
   someone created since step 2 wins, and the save is a conflict;
5. the aside file is checked again, for a writer that held it open and
   wrote after step 3; if it changed, it is kept as a conflict copy rather
   than deleted. Otherwise it is deleted.

Every version some other writer produced therefore ends up at the board's
name, in the aside file put back, or in a conflict copy. Between steps 2 and
4 (two in-process syscalls) the board's name is briefly absent: a reader
then sees no file, and a delete in that instant fails (ENOENT) rather than
being undone silently. Without openat2, the sandbox's no-replace move is a
check then a rename, and step 4 has a small window again.
*/
export async function replaceBoardFile({
  fs,
  path,
  text,
  expected,
  hooks,
}: {
  fs: BoardFilesystem;
  path: string;
  text: string;
  expected: string;
  hooks?: ReplaceHooks;
}): Promise<"ok" | "conflict"> {
  const id = randomUUID();
  const tmp = sidePath(path, id, "tmp");
  const aside = sidePath(path, id, "aside");
  let holdingAside = false;
  let placed = false;
  await fs.writeFile(tmp, text);
  try {
    try {
      const mode = (await fs.lstat(path)).mode & 0o7777;
      await fs.chmod(tmp, mode);
    } catch (err) {
      if (isMissing(err)) return "conflict";
      throw err;
    }
    try {
      await fs.rename(path, aside);
    } catch (err) {
      if (isMissing(err)) return "conflict";
      throw err;
    }
    holdingAside = true;
    await hooks?.afterAside?.();
    if (!(await holdsExactly(fs, aside, expected))) return "conflict";
    await hooks?.afterVerify?.();
    try {
      await fs.move(tmp, path, { overwrite: false });
    } catch (err) {
      if (isExists(err)) return "conflict";
      throw err;
    }
    placed = true;
    await hooks?.afterPlace?.();
    if (!(await holdsExactly(fs, aside, expected))) {
      holdingAside = false;
      await keepVersion(fs, aside, path);
    }
    return "ok";
  } finally {
    if (!placed) await fs.unlink(tmp).catch(() => {});
    if (holdingAside) {
      if (placed) {
        // Exactly expected, the version this save replaces.
        await fs.unlink(aside).catch(() => {});
      } else {
        await keepVersion(fs, aside, path).catch((err) =>
          logger.warn("board: could not put a version back", {
            path,
            aside,
            err: `${err}`,
          }),
        );
      }
    }
  }
}

// A board left aside by a host that stopped between steps 2 and 4 of
// replaceBoardFile goes back to its name, if that is free.
async function recoverAside(fs: BoardFilesystem, path: string) {
  const dir = posix.dirname(path);
  const prefix = `.${posix.basename(path)}.`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const asides = names.filter(
    (name) =>
      name.startsWith(prefix) &&
      /^[0-9a-f-]{36}\.sage-board-aside$/.test(name.slice(prefix.length)),
  );
  for (const name of asides) {
    await keepVersion(fs, posix.join(dir, name), path).catch(() => {});
  }
}

export function fileOf(
  fs: BoardFilesystem,
  path: string,
  hooks?: ReplaceHooks,
): BoardFile {
  return {
    info: async () => {
      try {
        let stats;
        try {
          stats = await fs.lstat(path);
        } catch (err) {
          if (!isMissing(err)) throw err;
          await recoverAside(fs, path);
          stats = await fs.lstat(path);
        }
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
    // The sandbox's descriptor-anchored read: a regular file only, at most
    // maxBytes + 1 bytes, and only if the opened file is still the board's
    // identity (not swapped for a link elsewhere).
    read: async (maxBytes: number): Promise<BoardRead | undefined> => {
      try {
        const text = await readBoundedText(fs, path, maxBytes, (identity) => {
          let resolved: string | undefined;
          try {
            resolved = canonicalBoardPath(identity);
          } catch {}
          if (resolved !== canonicalBoardPath(path)) {
            throw Object.assign(
              Error(`the board's file is now ${identity}, not ${path}`),
              { code: "EBOARDIDENTITY" },
            );
          }
        });
        return { text };
      } catch (err: any) {
        if (isMissing(err)) return;
        if (err?.code === "EFBIG") return { tooLarge: true };
        if (err?.code === "EACCES" || err?.code === "EBOARDIDENTITY") {
          return { refused: `${err?.message ?? err}`.slice(0, 500) };
        }
        throw err;
      }
    },
    // Replace the file only if it is still exactly expected, without ever
    // writing over or deleting anyone else's version (see replaceBoardFile).
    replace: (text: string, expected: string) =>
      replaceBoardFile({ fs, path, text, expected, hooks }),
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
  fs: BoardFilesystem;
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
  let reserve = 0;
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
    // Its size is charged from now, through start and close.
    reserve = info.size;
  }
  const manager = await registry.open(
    key,
    path,
    () => startBoard({ ...opts, path }),
    reserve,
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
