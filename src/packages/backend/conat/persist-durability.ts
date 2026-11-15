/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The durability records of disk-backed persist streams (finding 028), on
// tmpfs: see conat/persist/durability-records.
//
// root: COCALC_PERSIST_RUN_DIR, else /run/cocalc-persist.  It must be on
// tmpfs and writable only by the persist user (the host provisions it).

import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  createDurabilityRecords,
  type DurabilityRecords,
  type PostRebootRecords,
} from "@cocalc/conat/persist/durability-records";
import { syncFiles } from "@cocalc/backend/data";
import { ownerOfLocalPath } from "@cocalc/conat/persist/util";
import { isSqliteSyncError } from "@cocalc/conat/persist/storage";
import { spawn } from "node:child_process";

const logger = getLogger("persist:durability");

export const DEFAULT_PERSIST_RUN_DIR = "/run/cocalc-persist";

export function persistRunDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COCALC_PERSIST_RUN_DIR || DEFAULT_PERSIST_RUN_DIR;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

// A process's start time, /proc/<pid>/stat field 22 (clock ticks since
// boot); undefined if it can't be read.  The comm field (2) may contain
// spaces and parentheses, so fields are counted after its last ")".
export function procStartTime(
  pid: number | "self",
  readFile: (path: string) => string = (path) =>
    fs.readFileSync(path, "utf8"),
): string | undefined {
  let stat: string;
  try {
    stat = readFile(`/proc/${pid}/stat`);
  } catch {
    return;
  }
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // rest[0] is field 3, so field 22 is rest[19]
  const start = rest[19];
  return start != null && /^\d+$/.test(start) ? start : undefined;
}

// Whether the writer of a dirty record still runs: false only if its pid is
// gone, or is now a different process (another start time).  Anything else
// (no /proc, a record without procStart for a pid that exists) counts as
// alive: its record keeps refusing (fail closed).
export function isWriterAlive(
  pid: number,
  procStart?: string,
  readFile?: (path: string) => string,
): boolean {
  let exists = true;
  try {
    (readFile ?? ((path) => fs.readFileSync(path, "utf8")))(
      `/proc/${pid}/stat`,
    );
  } catch (err) {
    if ((err as any)?.code === "ENOENT") exists = false;
    else return true;
  }
  if (!exists) return false;
  if (procStart == null) return true;
  const now = procStartTime(pid, readFile);
  if (now == null) return true;
  return now === procStart;
}

// The persistent state directory for the post-reboot records (§3.2.5 (b)):
// COCALC_PERSIST_STATE_DIR, else <the persist data dir>/.cocalc-persist-state.
// Host-owned, never in a project; undefined if neither is known.
export function persistStateDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.COCALC_PERSIST_STATE_DIR) return env.COCALC_PERSIST_STATE_DIR;
  if (syncFiles.local) return posix.join(syncFiles.local, ".cocalc-persist-state");
  return undefined;
}

function fsyncPath(path: string, flags = "r"): void {
  const fd = fs.openSync(path, flags);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Durable records in <dir>/poisoned/<key>: temp file, fsync, rename, fsync of
// the directory; removal unlinks, then fsyncs the directory.
export function nodePostRebootRecords(dir: string): PostRebootRecords {
  const recordsDir = posix.join(dir, "poisoned");
  const ensure = () => {
    fs.mkdirSync(recordsDir, { recursive: true, mode: 0o700 });
  };
  return {
    write: (key, data) => {
      ensure();
      const target = posix.join(recordsDir, key);
      const tmp = `${target}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, target);
      fsyncPath(recordsDir);
    },
    exists: (key) => {
      try {
        fs.lstatSync(posix.join(recordsDir, key));
        return true;
      } catch (err) {
        return (err as any)?.code !== "ENOENT";
      }
    },
    remove: (key) => {
      try {
        fs.unlinkSync(posix.join(recordsDir, key));
      } catch (err) {
        if ((err as any)?.code === "ENOENT") return;
        throw err;
      }
      fsyncPath(recordsDir);
    },
  };
}

// records in root, for a process generation (a new one by default)
export function nodeDurabilityRecords(
  root: string,
  generation = `${process.pid}-${randomUUID()}`,
  stateDir: string | undefined = persistStateDir(),
): DurabilityRecords {
  return createDurabilityRecords({
    root,
    generation,
    fs: fs as any,
    sha256: sha256Hex,
    pid: process.pid,
    procStart: procStartTime("self"),
    isWriterAlive: (pid, procStart) => isWriterAlive(pid, procStart),
    postReboot: stateDir == null ? undefined : nodePostRebootRecords(stateDir),
    warn: (message, err) => logger.warn(message, { err: `${err}` }),
  });
}

// (b) records that could not be written are retried every minute, with a
// non-paging alert each time (§3.2.5 (b)).
export const POST_REBOOT_RETRY_MS = 60_000;
let retryTimer: ReturnType<typeof setInterval> | undefined;
function startPostRebootRetry(r: DurabilityRecords): void {
  if (retryTimer != null) return;
  retryTimer = setInterval(() => {
    if (r.postRebootPending() > 0) r.retryPostReboot();
  }, POST_REBOOT_RETRY_MS);
  (retryTimer as any).unref?.();
}

// A full PRAGMA integrity_check of a closed database in a child process
// (never on the persist main thread), at most one at a time per host, at most
// 10 minutes (§3.2.6, §3.2.9).  The child exits with process.exit, so its
// connection is never closed (a close would checkpoint).
export const INTEGRITY_CHECK_TIMEOUT_MS = 10 * 60_000;
const INTEGRITY_CHECK_SOURCE = String.raw`
const { DatabaseSync } = require("node:sqlite");
let out;
try {
  const db = new DatabaseSync(process.argv[1]);
  db.exec("PRAGMA busy_timeout=5000");
  const rows = db.prepare("PRAGMA integrity_check").all();
  out = { ok: rows.length === 1 && Object.values(rows[0])[0] === "ok", rows: rows.length };
} catch (err) {
  out = { ok: false, error: String(err && err.message || err).slice(0, 200) };
}
process.stdout.write(JSON.stringify(out) + String.fromCharCode(10));
process.exit(0);
`;
let integrityQueue: Promise<unknown> = Promise.resolve();
export function integrityCheckClosedDatabase(
  dbPath: string,
  timeoutMs: number = INTEGRITY_CHECK_TIMEOUT_MS,
): Promise<{ ok: boolean; why?: string }> {
  const run = () =>
    new Promise<{ ok: boolean; why?: string }>((resolve) => {
      let stdout = "";
      let stderr = "";
      const child = spawn(
        process.execPath,
        ["-e", INTEGRITY_CHECK_SOURCE, dbPath],
        { shell: false, env: {}, cwd: "/", stdio: ["ignore", "pipe", "pipe"] },
      );
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (d) => {
        if (stdout.length < 4096) stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < 1024) stderr += d.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, why: `${err}` });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (code !== 0 || signal != null) {
          resolve({
            ok: false,
            why: `exit ${code} ${signal} ${stderr.slice(0, 300)}`,
          });
          return;
        }
        try {
          const r = JSON.parse(stdout.trim());
          resolve(r.ok === true ? { ok: true } : { ok: false, why: stdout.trim() });
        } catch {
          resolve({ ok: false, why: "unparsable output" });
        }
      });
    });
  const next = integrityQueue.then(run, run);
  integrityQueue = next.catch(() => {});
  return next;
}

let records: DurabilityRecords | undefined;

// Every MAINTENANCE open of a persist database (promotion, inspection,
// compaction, the trim's offline reads; DESIGN §4A row 9, vanta P1) is
// refused unless the stream's records are clean: a poisoned file, or one a
// process left mid-write (dead or alive), must not be opened, read, copied or
// checkpointed outside the open path that verifies it.  dbPath: the physical
// <path>.db, as the stream was opened.  B2-M1 (ops0 3587): the records are
// checked WITH the stream's owner, derived from the physical path as the open
// path keys it, so a project-level poison (Q-F, §4A row 9) refuses too; a
// path whose owner can't be derived is refused.
export function assertPersistMaintenanceOpenAllowed(
  dbPath: string,
  check: (id: string, owner: string) => string = (id, owner) =>
    persistDurabilityRecords().check(id, owner),
  ownerOf: (id: string) => string | undefined = ownerOfLocalPath,
): void {
  const id = posix.normalize(dbPath.replace(/\.db$/, ""));
  const owner = ownerOf(id);
  if (owner == null) {
    throw new Error(
      `persist maintenance open refused (finding 028): the stream's owner can't be derived from its path: ${dbPath}`,
    );
  }
  const state = check(id, owner);
  if (state !== "ok") {
    throw new Error(
      `persist maintenance open refused (finding 028): the stream is ${state}: ${dbPath}`,
    );
  }
}

// SA-B2-1: a maintenance WRITE to a stream file (the trim's VACUUM and its
// checkpoints, promotion's TRUNCATE checkpoint) can consume a sync error just
// like a stream's own COMMIT.  So it runs with the stream's dirty record
// armed (with its owner), exactly like a connection's write: a SQLite sync
// error makes that record the poisoned-file record (refused until verified,
// in this boot and after a reboot via the post-reboot record); the record
// is disarmed only when fn returned or threw a non-sync error.  If the
// record can't be created, the write does not start.
// An fsync a maintenance write makes itself (fsyncMaintenanceOutput): its
// error is a sync error like SQLite's (§3.2.2), and EDQUOT/ENOSPC there is
// the project's quota (Q-F, §3.2.3).
export class MaintenanceFsyncError extends Error {
  constructor(
    readonly path: string,
    readonly cause: NodeJS.ErrnoException,
  ) {
    super(`fsync ${path}: ${cause?.code ?? cause}`);
  }
}

// DESIGN §4A row 10 (astra 3548): a maintenance write's output is durable
// BEFORE the maintenance step completes -- the file and its directory are
// fsync'd here (O_NOFOLLOW), the next open's barrier is no substitute.
export function fsyncMaintenanceOutput(dbPath: string, fsx: Pick<typeof fs, "openSync" | "fsyncSync" | "closeSync"> = fs): void {
  for (const [path, flags] of [
    [dbPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW],
    [posix.dirname(dbPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY],
  ] as const) {
    let fd: number | undefined;
    try {
      fd = fsx.openSync(path, flags);
      fsx.fsyncSync(fd);
    } catch (err) {
      if (fd != null) {
        try {
          fsx.closeSync(fd);
        } catch {}
      }
      throw new MaintenanceFsyncError(path, err as NodeJS.ErrnoException);
    }
    try {
      fsx.closeSync(fd);
    } catch (err) {
      // (review advisory) not swallowed: the step is not reported done
      throw new MaintenanceFsyncError(path, err as NodeJS.ErrnoException);
    }
  }
}

export function runArmedMaintenanceWrite<T>(
  dbPath: string,
  owner: string,
  where: string,
  fn: () => T,
  records: ArmedRecords = persistDurabilityRecords(),
): T {
  const id = armMaintenanceWrite(dbPath, owner, records);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    settleMaintenanceWriteError(id, dbPath, owner, where, err, records);
    throw err;
  }
  records.disarm(id);
  return result;
}

// A maintenance write whose completion can't be proven: a failure after a
// read-write connection to the stream's file was opened that is not a sync
// error (the close may still have checkpointed, unreported), or a worker
// that ended without its report (killed, timed out, no parseable result).
// Its record stays ARMED: the stream stays refused in this process and is
// verified at the next start (H-b).  (SA-B2-3; review's design note)
export class MaintenanceCompletionUnprovenError extends Error {
  constructor(
    readonly path: string,
    readonly why: unknown,
  ) {
    super(`persist maintenance write not proven complete: ${path}: ${why}`);
  }
}

// A read-write maintenance connection to a stream's file: opened, fn run,
// then an explicit TRUNCATE checkpoint (a sync error surfaces here, and the
// close has nothing left to write) and the close.  Any failure after the
// open that is not a sync error is MaintenanceCompletionUnprovenError.
// Stated limit (all sites): a checkpoint that stays busy is not detected;
// these run under the maintenance claim or the project fence, so no other
// connection exists.
export function withMaintenanceConnection<T>(
  dbPath: string,
  busyTimeoutMs: number,
  fn: (db: any) => T,
  open: (path: string) => any = (path) => new (require("node:sqlite").DatabaseSync)(path),
): T {
  const db = open(dbPath); // a failure here: nothing was opened, nothing written
  let result: T;
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}`);
    result = fn(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    try {
      db.close();
    } catch (closeErr) {
      if (isSqliteSyncError(closeErr)) throw closeErr;
    }
    if (isSqliteSyncError(err)) throw err;
    throw new MaintenanceCompletionUnprovenError(dbPath, err);
  }
  db.close(); // a sync error here propagates: the runner poisons
  return result;
}

export async function runArmedMaintenanceWriteAsync<T>(
  dbPath: string,
  owner: string,
  where: string,
  fn: () => Promise<T>,
  records: ArmedRecords = persistDurabilityRecords(),
): Promise<T> {
  const id = armMaintenanceWrite(dbPath, owner, records);
  let result: T;
  try {
    result = await fn();
  } catch (err) {
    settleMaintenanceWriteError(id, dbPath, owner, where, err, records);
    throw err;
  }
  records.disarm(id);
  return result;
}

type ArmedRecords = Pick<
  DurabilityRecords,
  "arm" | "disarm" | "poison" | "poisonProject"
>;

function armMaintenanceWrite(
  dbPath: string,
  owner: string,
  records: ArmedRecords,
): string {
  const id = posix.normalize(dbPath.replace(/\.db$/, ""));
  try {
    records.arm(id, owner);
  } catch (err) {
    throw new Error(
      `persist maintenance write refused (finding 028): the dirty record can't be created: ${dbPath}: ${err}`,
    );
  }
  return id;
}

// a sync error: the record becomes the poison record (never disarmed);
// completion unproven: stays armed; any other error: disarmed
function settleMaintenanceWriteError(
  id: string,
  dbPath: string,
  owner: string,
  where: string,
  err: unknown,
  records: ArmedRecords,
): void {
  if (err instanceof MaintenanceCompletionUnprovenError) {
    // neither disarmed nor poisoned: the record stays armed
    logger.error(
      "persist: a maintenance write could not be proven complete; its record stays armed and the stream refused (finding 028)",
      { dbPath, where, err: `${err}` },
    );
    return;
  }
  if (isSqliteSyncError(err) || err instanceof MaintenanceFsyncError) {
    const errno =
      err instanceof MaintenanceFsyncError ? `${err.cause?.code ?? ""}` : "";
    records.poison(id, {
      where: `maintenance:${where}`,
      errcode: Number((err as any)?.errcode ?? 0),
      ...(errno ? { errno } : {}),
    });
    if (errno === "EDQUOT" || errno === "ENOSPC") {
      // the project's quota at our fsync: every stream of the project (Q-F)
      records.poisonProject(owner, { where: `maintenance:${where}`, errno, path: dbPath });
    }
    logger.error(
      "PERSIST FILE POISONED (finding 028): a sync error in a maintenance write; the file is refused until it is verified",
      { dbPath, where, err: `${err}` },
    );
    return;
  }
  records.disarm(id);
}

// the records of this process (one generation per process)
export function persistDurabilityRecords(): DurabilityRecords {
  if (records == null) {
    records = nodeDurabilityRecords(persistRunDir());
    startPostRebootRetry(records);
  }
  return records;
}

// ---------------------------------------------------------------------------
// Start-up preconditions (028 B-3a, DESIGN §3.2.5 start-up rule, §3.2.1 SA
// T3, vanta R1 / N-3; the TWO host-wide start-up refusals, Q9).  Checked once
// per process, at the first disk-stream open.  If one fails, DISK-stream
// service is refused (ephemeral streams still run), with a clear error code
// and a page.
// - the records root must be a directory on a per-BOOT tmpfs (a directory on
//   a persistent disk would survive a reboot, and its dirty records would
//   then refuse every open), owned by this process's uid, not writable by
//   group or others, and writable by us;
// - the NOFILE soft limit must cover SQLite's fds for every stream (db, -wal,
//   -shm) plus our short-lived barrier fds: >= 3 x MAX_GLOBAL + margin.
export const TMPFS_MAGIC = 0x01021994;
export const MIN_NOFILE = 3 * 10_000 + 1024;

export function checkPersistRunDir(
  dir: string,
  {
    allowNonTmpfs = process.env.COCALC_PERSIST_RUN_DIR_ALLOW_NON_TMPFS === "1",
    uid = process.getuid?.(),
  }: { allowNonTmpfs?: boolean; uid?: number } = {},
): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") return `records root: ${err}`;
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      st = fs.lstatSync(dir);
    } catch (err2) {
      return `records root ${dir} is missing and can't be created: ${err2}`;
    }
  }
  if (!st.isDirectory()) return `records root ${dir} is not a directory`;
  if (uid != null && st.uid !== uid) {
    return `records root ${dir} is owned by uid ${st.uid}, not ${uid}`;
  }
  if ((st.mode & 0o022) !== 0) {
    return `records root ${dir} is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`;
  }
  if (!allowNonTmpfs) {
    let type: number | undefined;
    try {
      type = Number((fs as any).statfsSync(dir).type);
    } catch (err) {
      return `records root ${dir}: statfs failed: ${err}`;
    }
    if (type !== TMPFS_MAGIC) {
      return `records root ${dir} is not on tmpfs (fs type 0x${type.toString(16)}): its records would survive a reboot`;
    }
  }
  const probe = posix.join(dir, `.probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, "", { mode: 0o600 });
    fs.unlinkSync(probe);
  } catch (err) {
    return `records root ${dir} is not writable: ${err}`;
  }
  return undefined;
}

export function checkNofile(
  readLimits: () => string = () => fs.readFileSync("/proc/self/limits", "utf8"),
  min: number = MIN_NOFILE,
): string | undefined {
  let text: string;
  try {
    text = readLimits();
  } catch {
    return undefined; // no /proc (not Linux): nothing to check
  }
  const m = /^Max open files\s+(\S+)\s+(\S+)/m.exec(text);
  if (m == null) return "NOFILE: can't parse /proc/self/limits";
  const soft = m[1] === "unlimited" ? Infinity : Number(m[1]);
  if (!(soft >= min)) {
    return `NOFILE soft limit ${m[1]} is below ${min} (3 fds per stream x 10,000 streams + margin)`;
  }
  return undefined;
}

let startup: { ok: boolean; reason?: string; overrides?: string[] } | undefined;
export function persistStartupCheck(): {
  ok: boolean;
  reason?: string;
  overrides?: string[];
} {
  if (startup == null) {
    const reason = checkPersistRunDir(persistRunDir()) ?? checkNofile();
    // SA 3351 A1: the tmpfs override is for tests; on a host it is visible
    // (diagnostics) and logged at start
    const overrides =
      process.env.COCALC_PERSIST_RUN_DIR_ALLOW_NON_TMPFS === "1"
        ? ["COCALC_PERSIST_RUN_DIR_ALLOW_NON_TMPFS"]
        : [];
    if (overrides.length > 0) {
      logger.warn(
        "persist: the records root is NOT required to be on tmpfs (an override for tests; finding 028)",
        { overrides },
      );
    }
    startup = reason == null ? { ok: true, overrides } : { ok: false, reason, overrides };
    if (reason != null) {
      logger.error(
        "PERSIST ALERT (page): disk-backed persist streams are refused on this host until fixed (finding 028)",
        { reason },
      );
    }
  }
  return startup;
}

// tests only
export function resetPersistStartupCheckForTests(): void {
  startup = undefined;
}
