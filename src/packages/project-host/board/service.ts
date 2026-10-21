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

import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import type {
  BoardOpenResult,
  Filesystem,
  FilesystemBoardHandlers,
} from "@cocalc/conat/files/fs";
import { immerdb, type ImmerDB } from "@cocalc/conat/sync-doc/immer-db";
import { BOARD_WRITE_SERVICE } from "@cocalc/conat/persist/board-policy";
import { getLogger } from "@cocalc/backend/logger";
import { from_str as immerFromStr } from "@cocalc/sync/editor/immer-db/doc";
import { SyncClient } from "@cocalc/conat/sync-doc/sync-client";
import {
  BOARD_EDITABLE_LIMIT,
  BOARD_HOST_BYTE_LIMIT,
  BOARD_HOST_HARD_BYTE_LIMIT,
  BOARD_PRIMARY_KEYS,
  BOARD_STRING_COLS,
  boardSyncdbPath,
  isBoardJsonPath,
} from "@cocalc/util/board/names";
import {
  BOARD_FILE_RESET_REASON,
  boardHistoryActions,
  HISTORY_UNLOADABLE_DOCS,
  type BoardHistoryCause,
} from "@cocalc/util/board/history-unloadable";
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
import { REBUILD_LIMITS, rebuildBoardHistory } from "./history-rebuild";

const logger = getLogger("project-host:board");

const PROJECT_HOME = "/home/user";
export const BOARD_LEASE_MS = 90_000;
// What a client showing a board should renew its lease at.
export const BOARD_LEASE_RENEW_MS = 30_000;
const MAX_OPEN_BOARDS = 200;
const MAX_OPEN_BOARDS_PER_PROJECT = 20;
// With BOARD_HOST_HARD_BYTE_LIMIT reserved per board: about 100 boards.
const MAX_OPEN_BOARD_BYTES = 512 * 1024 * 1024;
// A syncdb or a first load slower than this fails the start.
const START_STEP_TIMEOUT_MS = 45_000;
// Every step of a start is bounded: the syncdb, a rebuild of an unloadable
// history (H1b-4) and the syncdb again, then the first load.  This is only
// the registry's backstop over all of them.
const START_TIMEOUT_MS = 3 * START_STEP_TIMEOUT_MS + REBUILD_LIMITS.deadlineMs;

let libPromise: Promise<BoardLib> | undefined;
// @sagemathinc/sagebrush-board is ESM; since 0.3.0 its exports offer
// "default", so the compiled require() of this import loads it.
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

// Side files of a save, beside the board (hidden): the new text before it
// is placed (tmp), and the version it replaced (aside), whose name carries
// the hash of what it held when set aside.
function sidePath(
  path: string,
  id: string,
  kind: "tmp" | "aside",
  hash?: string,
): string {
  return posix.join(
    posix.dirname(path),
    `.${posix.basename(path)}.${id}${hash ? `.${hash}` : ""}.sage-board-${kind}`,
  );
}

function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
  await keepAsConflictCopy(fs, p, path);
}

async function keepAsConflictCopy(
  fs: BoardFilesystem,
  p: string,
  path: string,
) {
  const copy = conflictPath(path);
  await fs.move(p, copy, { overwrite: false });
  logger.warn("board: kept another writer's version as a conflict copy", {
    path,
    copy,
  });
}

// Asides of saves running now in this process: never swept.
const activeAsides = new Set<string>();

/*
Replace the board's file with text, only if it is exactly expected:

1. text goes to a temp file beside the board;
2. the board is renamed aside (atomic: whatever is there at that instant,
   from anyone, is now in the aside file; a missing file is a conflict and
   is not created);
3. the aside file must be exactly expected, or it goes back (and the save
   is a conflict);
4. the temp file is renamed to the board's name only if nothing is there
   (renameNoReplace): a file someone created since step 2 wins, and the
   save is a conflict;
5. the aside file stays, as the previous version, until the next save of
   the board sweeps it (sweepSideFiles): deleted if it still holds what was
   set aside (its name has the hash), else kept as a conflict copy. So a
   writer that held the old file open and wrote to it after step 3 is not
   lost if it lands before the next save's sweep reads the aside; it is
   surfaced then. A write through such a descriptor after that read may be
   lost (the sweep deletes the old file), as with any rename-based save
   (editors, git checkout): programs should reopen the path.

What remains: between steps 2 and 4 (two in-process syscalls) the board's
name is absent; a reader then sees no file, and a delete in that instant
fails (ENOENT) rather than being undone. Step 4 is atomic only with openat2
(the sandbox's renameNoReplace, Linux in safe mode, which project hosts
use); with openat2 off or unavailable (unsafe mode, non-Linux, or
disableOpenAt2), the sandbox's no-replace move is a check then a rename,
and a file created in that window is written over.
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
  await sweepSideFiles(fs, path);
  const id = randomUUID();
  const tmp = sidePath(path, id, "tmp");
  const aside = sidePath(path, id, "aside", shortHash(expected));
  let holdingAside = false;
  let placed = false;
  activeAsides.add(aside);
  try {
    await fs.writeFile(tmp, text);
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
    return "ok";
  } finally {
    activeAsides.delete(aside);
    if (!placed) await fs.unlink(tmp).catch(() => {});
    if (holdingAside && !placed) {
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

/*
The side files of earlier saves of the board (none running now):

- An aside whose tmp is still there, with the board's name free: the host
  stopped between steps 2 and 4 of a save. The aside goes back.
- Any other aside: the version a save replaced. Deleted if it holds what
  its name's hash says, else (someone wrote to it after) a conflict copy.
- A tmp without its aside: an unplaced save's text, deleted.

A board deleted on purpose is never brought back: only an interrupted
save (its tmp still there) restores an aside.
*/
async function sweepSideFiles(fs: BoardFilesystem, path: string) {
  const dir = posix.dirname(path);
  const prefix = `.${posix.basename(path)}.`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const tmps = new Set<string>();
  const asides: { name: string; id: string; hash: string }[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    let m = /^([0-9a-f-]{36})\.sage-board-tmp$/.exec(rest);
    if (m) {
      tmps.add(m[1]);
      continue;
    }
    m = /^([0-9a-f-]{36})\.([0-9a-f]{16})\.sage-board-aside$/.exec(rest);
    if (m) asides.push({ name, id: m[1], hash: m[2] });
  }
  const asideIds = new Set(asides.map((a) => a.id));
  for (const { name, id, hash } of asides) {
    const p = posix.join(dir, name);
    if (activeAsides.has(p)) continue;
    try {
      if (tmps.has(id)) {
        // An interrupted save: put the board back if its name is free.
        await keepVersion(fs, p, path);
        await fs.unlink(sidePath(path, id, "tmp")).catch(() => {});
        continue;
      }
      let text: string | undefined;
      try {
        text = await readBoundedText(fs, p, BOARD_EDITABLE_LIMIT);
      } catch (err: any) {
        if (err?.code !== "EFBIG") throw err;
      }
      if (text !== undefined && shortHash(text) === hash) {
        await fs.unlink(p);
      } else {
        await keepAsConflictCopy(fs, p, path);
      }
    } catch (err) {
      logger.warn("board: could not sweep a side file", {
        path,
        name,
        err: `${err}`,
      });
    }
  }
  for (const id of tmps) {
    if (!asideIds.has(id)) {
      await fs.unlink(sidePath(path, id, "tmp")).catch(() => {});
    }
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
          await sweepSideFiles(fs, path);
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
  syncClient,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: BoardFilesystem;
  service?: string;
  manager?: Partial<ConstructorParameters<typeof BoardManager>[0]>;
  // for tests: the rebuild's history operations
  syncClient?: Parameters<typeof rebuildBoardHistory>[0]["syncClient"];
}): Promise<StartedBoard & { syncdb: ImmerDB }> {
  const lib = await loadBoardLib();
  const open = () =>
    openBoardSyncdb({
      client,
      project_id,
      path,
      service,
      timeoutMs: START_STEP_TIMEOUT_MS,
      writer: true,
    });
  const syncPath = boardSyncdbPath(path);
  const key = `${project_id}:${syncPath}`;
  let syncdb: ImmerDB;
  let recovered: BoardRecovered | undefined;
  try {
    syncdb = await open();
    // A rebuild an earlier start left unknown applied meanwhile.
    recovered = lateRecovery(key, syncdb);
  } catch (err) {
    if (!(err instanceof HistoryUnloadable)) throw err;
    // The history cannot be loaded: rebuild it from the file, once per
    // start (bounded history plan H1b-4).
    const ownClient = syncClient == null ? new SyncClient(client) : undefined;
    let rebuild: Awaited<ReturnType<typeof rebuildBoardHistory>>;
    try {
      rebuild = await rebuildBoardHistory({
        project_id,
        syncPath,
        file: fileOf(fs, path),
        lib,
        recordsToString,
        failedEpoch: err.history_epoch,
        syncClient: syncClient ?? ownClient!,
      });
    } finally {
      ownClient?.release();
    }
    // An unknown reset stays remembered until the board opens rebuilt (a
    // later refusal, e.g. busy while it settles, says nothing about it).
    if (rebuild.outcome == "rebuilt" || rebuild.outcome == "recovered") {
      unknownRebuilds.delete(key);
    } else if (rebuild.outcome == "unknown" && err.history_epoch != null) {
      rememberUnknown(key, err.history_epoch);
    }
    logger.info("board: history could not be loaded", {
      path,
      failedEpoch: err.history_epoch,
      outcome: rebuild.outcome,
      ...("cause" in rebuild ? { cause: rebuild.cause } : {}),
    });
    if (rebuild.outcome == "refused" || rebuild.outcome == "unknown") {
      throw new BoardHistoryRefused(rebuild.cause, rebuild.message);
    }
    if (
      rebuild.outcome == "rebuilt" ||
      rebuild.reset?.reason == BOARD_FILE_RESET_REASON
    ) {
      recovered = {
        reason: BOARD_FILE_RESET_REASON,
        ...(rebuild.reset?.time != null ? { time: rebuild.reset.time } : {}),
        history_epoch: rebuild.history_epoch,
      };
    }
    try {
      syncdb = await open();
    } catch (err) {
      throw new BoardHistoryRefused(
        "failed",
        `the board's history was reset, but it did not open: ${err}`.slice(
          0,
          300,
        ),
      );
    }
  }
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
  if (recovered != null) recoveredOf.set(manager, recovered);
  return { manager, syncdb, close: () => syncdb.close() };
}

type BoardRecovered = NonNullable<BoardOpenResult["recovered"]>;

// What each manager's start rebuilt or found rebuilt: every open of it
// says so; the browser shows it once per epoch.
const recoveredOf = new WeakMap<object, BoardRecovered>();

// Boards whose last rebuild here was sent with no answer in time
// (reset-unknown), with the epoch their history failed in: the next start
// that opens reports a rebuild from the file after that epoch.  Bounded.
const MAX_UNKNOWN_REBUILDS = 1000;
const unknownRebuilds = new Map<string, number>();

function rememberUnknown(key: string, failedEpoch: number) {
  unknownRebuilds.delete(key);
  unknownRebuilds.set(key, failedEpoch);
  while (unknownRebuilds.size > MAX_UNKNOWN_REBUILDS) {
    unknownRebuilds.delete(unknownRebuilds.keys().next().value!);
  }
}

function lateRecovery(
  key: string,
  syncdb: ImmerDB,
): BoardRecovered | undefined {
  const failedEpoch = unknownRebuilds.get(key);
  if (failedEpoch == null) return;
  unknownRebuilds.delete(key);
  try {
    const settings = syncdb.get_settings();
    const epoch = settings.get("history_epoch");
    const reset = settings.get("history_reset");
    const reason = reset?.get?.("reason");
    const time = reset?.get?.("time");
    if (
      typeof epoch == "number" &&
      epoch > failedEpoch &&
      reason == BOARD_FILE_RESET_REASON
    ) {
      return {
        reason,
        ...(typeof time == "number" ? { time } : {}),
        history_epoch: epoch,
      };
    }
  } catch (err) {
    logger.debug("board: could not read the history's reset", {
      key,
      err: `${err}`,
    });
  }
}

// for tests
export function forgetUnknownRebuilds(): void {
  unknownRebuilds.clear();
}

// The board's syncdb reported that its history cannot be loaded.
export class HistoryUnloadable extends Error {
  constructor(
    path: string,
    // the epoch the persist server failed in, if it said
    public history_epoch?: number,
  ) {
    super(`the edit history of ${path} cannot be loaded`);
  }
}

// The history could not be loaded and was not rebuilt.
export class BoardHistoryRefused extends Error {
  constructor(
    public cause: BoardHistoryCause,
    message: string,
  ) {
    super(message);
  }
}

// A board's live document. Browsers open it with the same options.
export async function openBoardSyncdb({
  client,
  project_id,
  path,
  service,
  timeoutMs,
  writer,
}: {
  client: ConatClient;
  project_id: string;
  path: string;
  service?: string;
  timeoutMs?: number;
  // The board's manager: it writes the board's stream through the host's
  // board write service, as the hub. Every other replica can only read it.
  writer?: boolean;
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
    ...(writer
      ? { patchesPersist: { service: BOARD_WRITE_SERVICE, persistUser: {} } }
      : {}),
  });
  if (!syncdb.isReady()) {
    try {
      const ready = new Promise<void>((resolve, reject) => {
        syncdb.once("ready", () => resolve());
        syncdb.once("error", reject);
        // the history cannot be loaded: waiting would not help (H1b-4)
        syncdb.once("history-unloadable", (info: any) =>
          reject(
            new HistoryUnloadable(
              path,
              typeof info?.history_epoch == "number"
                ? info.history_epoch
                : undefined,
            ),
          ),
        );
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
  const recovered = recoveredOf.get(manager);
  return {
    path,
    syncdbPath: boardSyncdbPath(path),
    ...manager.getStatus(),
    ...(recovered != null ? { recovered } : {}),
  } as BoardOpenResult;
}

// A board whose history could not be loaded nor rebuilt: why, and the ways
// to its content that do not depend on the rebuild.  Paths only.
export function historyUnloadableResult(
  path: string,
  cause: BoardHistoryCause,
  message: string,
): BoardOpenResult {
  return {
    ...boardPaths(path),
    state: "history-unloadable",
    cause,
    message,
    actions: boardHistoryActions(cause),
    docs: HISTORY_UNLOADABLE_DOCS,
  };
}

interface BoardRequest {
  client: ConatClient;
  project_id: string;
  path: string;
  fs: Filesystem;
  // The syncdb's file service (tests; the host's default otherwise).
  service?: string;
  // for tests: the history operations of a rebuild
  syncClient?: Parameters<typeof rebuildBoardHistory>[0]["syncClient"];
}

const registry = new BoardRegistry({
  leaseMs: BOARD_LEASE_MS,
  maxOpen: MAX_OPEN_BOARDS,
  maxPerGroup: MAX_OPEN_BOARDS_PER_PROJECT,
  maxTotalBytes: MAX_OPEN_BOARD_BYTES,
  startTimeoutMs: START_TIMEOUT_MS,
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
    if (info.size > BOARD_HOST_BYTE_LIMIT) {
      return {
        path,
        status: {
          ...boardPaths(path),
          state: "too-large",
          bytes: info.size,
          message: `the board is ${info.size} bytes, over the ${BOARD_HOST_BYTE_LIMIT} a board can be edited at`,
        },
      };
    }
    // A board may grow to the host's hard limit before its manager closes
    // it: that much is charged from now, through start and close.
    reserve = Math.max(info.size, BOARD_HOST_HARD_BYTE_LIMIT);
  }
  let manager: BoardManagerLike;
  try {
    manager = await registry.open(
      key,
      path,
      () => startBoard({ ...opts, path }),
      reserve,
    );
  } catch (err) {
    if (err instanceof BoardHistoryRefused) {
      return {
        path,
        status: historyUnloadableResult(path, err.cause, err.message),
      };
    }
    throw err;
  }
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

// The file service's board handlers, or none (board calls then fail with
// ENOSYS, and no manager is ever created) unless the host enables board
// editing with COCALC_PROJECT_HOST_BOARD_EDITING=1.
//
// DEPLOYMENT INVARIANT: COCALC_PROJECT_HOST_BOARD_EDITING stays unset on
// every host until a server-enforced persist policy for board streams is
// deployed and validated there. Until then a board's limits are checked
// only after a change has been applied to its syncdb, and its history is
// replayed on open before any check. That policy must bound direct stream
// clients and their configuration, not only this manager's checks.
export function boardHandlers({
  client,
  projectIdOf,
  env = process.env,
}: {
  client: ConatClient;
  projectIdOf: (subject: string) => string;
  env?: NodeJS.ProcessEnv;
}): FilesystemBoardHandlers | undefined {
  if (env.COCALC_PROJECT_HOST_BOARD_EDITING !== "1") return undefined;
  return {
    open: async ({ subject, path, fs }) =>
      await openBoard({ client, project_id: projectIdOf(subject), path, fs }),
    save: async ({ subject, path, fs }) =>
      await saveBoard({ client, project_id: projectIdOf(subject), path, fs }),
  };
}
