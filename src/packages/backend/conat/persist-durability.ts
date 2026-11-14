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

let startup: { ok: boolean; reason?: string } | undefined;
export function persistStartupCheck(): { ok: boolean; reason?: string } {
  if (startup == null) {
    const reason = checkPersistRunDir(persistRunDir()) ?? checkNofile();
    startup = reason == null ? { ok: true } : { ok: false, reason };
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
