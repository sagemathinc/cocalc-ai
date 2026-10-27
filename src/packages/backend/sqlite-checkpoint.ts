/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
WAL checkpoints off the event loop.

node:sqlite is synchronous. In WAL mode with synchronous=NORMAL a commit
does not fsync, but SQLite's automatic checkpoint (every ~1000 WAL pages)
runs inside whichever commit crosses the threshold, and it fsyncs the WAL
and the database. On a project host the databases live on the busy btrfs
filesystem, where an fsync waits for the running transaction commit:
during snapshot or subvolume work that took 5-23 s, and the whole
project-host process (every project start on the host) stood still.

deferWalCheckpoints(db, file) turns automatic checkpoints off on that
connection and lets one worker thread checkpoint the registered files
instead, with its own connections (wal_checkpoint(PASSIVE): it never
blocks writers or readers). If the worker stops succeeding and a WAL grows
past maxWalBytes (64 MiB), the connections go back to SQLite's old
best-effort automatic checkpoints until the worker recovers. That is a
trigger, not a hard cap: a long reader that pins the WAL stops inline
checkpoints too, and the WAL keeps growing until it lets go.

Durability is unchanged: a checkpoint only copies committed pages from the
WAL into the database file. What a crash can lose depends on the
connection's synchronous setting, not on when checkpoints run.
*/

import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";

import getLogger from "@cocalc/backend/logger";

const logger = getLogger("backend:sqlite-checkpoint");

export const DEFAULT_CHECKPOINT_INTERVAL_MS = 5_000;
export const DEFAULT_MAX_WAL_BYTES = 64 * 1024 * 1024;
// SQLite's default wal_autocheckpoint, used while the worker is unhealthy.
const INLINE_AUTOCHECKPOINT_PAGES = 1000;

interface ExecDatabase {
  exec(sql: string): unknown;
}

// One per database file; every connection to it that deferred its
// checkpoints is tracked, and the worker checkpoints the file once.
interface Registration {
  file: string;
  dbs: Set<ExecDatabase>;
  maxWalBytes: number;
  // Last complete checkpoint: every WAL frame copied into the database.
  lastSuccessAt: number;
  lastResult?: CheckpointResult;
  inlineFallback: boolean;
  // Since when checkpoints have run but left frames behind (a reader holding
  // an old snapshot, or writers outpacing the worker).
  incompleteSince?: number;
}

export interface CheckpointResult {
  file: string;
  at: number;
  error?: string;
  busy?: number;
  log?: number;
  checkpointed?: number;
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const connections = new Map();
parentPort.on("message", (msg) => {
  if (msg?.type === "forget") {
    const db = connections.get(msg.file);
    connections.delete(msg.file);
    try { db?.close(); } catch {}
    return;
  }
  if (msg?.type !== "checkpoint") return;
  for (const file of msg.files) {
    const at = Date.now();
    try {
      let db = connections.get(file);
      if (db == null) {
        db = new DatabaseSync(file);
        db.exec("PRAGMA synchronous=NORMAL");
        connections.set(file, db);
      }
      const row = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      parentPort.postMessage({ file, at, busy: row.busy, log: row.log, checkpointed: row.checkpointed });
    } catch (err) {
      const db = connections.get(file);
      connections.delete(file);
      try { db?.close(); } catch {}
      parentPort.postMessage({ file, at, error: String(err && err.message ? err.message : err) });
    }
  }
});
`;

const registrations = new Map<string, Registration>();
let worker: Worker | undefined;
let timer: NodeJS.Timeout | undefined;
let intervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS;
let checking = false;
// For tests: a worker that never answers, or one that cannot be created.
let workerMode: "enabled" | "silent" | "throws" = "enabled";

function isTestRuntime(): boolean {
  return process.env.JEST_WORKER_ID != null;
}

function ensureWorker(): Pick<Worker, "postMessage"> {
  if (workerMode === "silent") return { postMessage: () => {} };
  if (workerMode === "throws") {
    throw new Error("unable to create a worker thread (test)");
  }
  if (worker != null) return worker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.unref();
  w.on("message", (result: CheckpointResult) => {
    const reg = registrations.get(result?.file);
    if (reg == null) return;
    reg.lastResult = result;
    if (result.error == null && checkpointComplete(result)) {
      reg.lastSuccessAt = result.at;
      reg.incompleteSince = undefined;
      if (reg.inlineFallback) {
        setInlineFallback(reg, false);
      }
    } else if (result.error == null) {
      // PASSIVE reports success even when it could not copy every frame.
      // That is not progress: keep the stale timer.
      if (reg.incompleteSince == null) {
        reg.incompleteSince = result.at;
      } else if (result.at - reg.incompleteSince > 3 * intervalMs) {
        logger.warn("sqlite WAL checkpoints are not completing", {
          file: reg.file,
          log: result.log,
          checkpointed: result.checkpointed,
          busy: result.busy,
          since: new Date(reg.incompleteSince).toISOString(),
        });
      }
    } else {
      logger.warn("sqlite WAL checkpoint failed in the worker", {
        file: reg.file,
        error: result.error,
      });
    }
  });
  w.on("error", (err) => {
    logger.warn("sqlite WAL checkpoint worker failed", { err: `${err}` });
  });
  w.on("exit", () => {
    if (worker === w) worker = undefined;
  });
  worker = w;
  return w;
}

// A checkpoint copied every frame in the WAL (or the WAL was empty).
export function checkpointComplete(result: CheckpointResult): boolean {
  const log = Number(result.log ?? 0);
  const checkpointed = Number(result.checkpointed ?? 0);
  return log <= 0 || checkpointed >= log;
}

function setAutocheckpoint(
  reg: Registration,
  db: ExecDatabase,
  on: boolean,
): void {
  try {
    db.exec(
      `PRAGMA wal_autocheckpoint=${on ? INLINE_AUTOCHECKPOINT_PAGES : 0}`,
    );
  } catch (err) {
    // The connection may have been closed without forgetWalCheckpoints.
    logger.warn("unable to change sqlite wal_autocheckpoint", {
      file: reg.file,
      err: `${err}`,
    });
  }
}

function setInlineFallback(reg: Registration, on: boolean): void {
  for (const db of reg.dbs) {
    setAutocheckpoint(reg, db, on);
  }
  reg.inlineFallback = on;
  if (on) {
    logger.warn(
      "sqlite WAL is large and the checkpoint worker is not keeping up; checkpointing inline until it recovers",
      { file: reg.file, max_wal_bytes: reg.maxWalBytes },
    );
  } else {
    logger.info("sqlite WAL checkpoint worker recovered", { file: reg.file });
  }
}

async function walBytes(file: string): Promise<number> {
  try {
    return (await stat(`${file}-wal`)).size;
  } catch {
    return 0;
  }
}

export async function runCheckpointPass(now = Date.now()): Promise<void> {
  if (checking || registrations.size === 0) return;
  checking = true;
  try {
    try {
      ensureWorker().postMessage({
        type: "checkpoint",
        files: [...registrations.keys()],
      });
    } catch (err) {
      // No worker this time: the fallback checks below still have to run, or
      // a WAL could grow without bound.
      logger.warn("unable to start sqlite WAL checkpoints in the worker", {
        err: `${err}`,
      });
    }
    for (const reg of registrations.values()) {
      if (reg.inlineFallback) continue;
      const stale = now - reg.lastSuccessAt > 3 * intervalMs;
      if (stale && (await walBytes(reg.file)) > reg.maxWalBytes) {
        setInlineFallback(reg, true);
      }
    }
  } finally {
    checking = false;
  }
}

function ensureTimer(): void {
  if (timer != null) return;
  timer = setInterval(() => {
    void runCheckpointPass().catch((err) =>
      logger.warn("sqlite WAL checkpoint pass failed", { err: `${err}` }),
    );
  }, intervalMs);
  timer.unref();
}

/**
 * Move this connection's WAL checkpoints to the background worker. Call it
 * right after setting journal_mode=WAL. No-op for in-memory databases, in
 * jest (unless enableInTests), and with COCALC_SQLITE_INLINE_CHECKPOINTS=1.
 */
export function deferWalCheckpoints(
  db: ExecDatabase,
  file: string,
  {
    maxWalBytes = DEFAULT_MAX_WAL_BYTES,
    enableInTests = false,
  }: { maxWalBytes?: number; enableInTests?: boolean } = {},
): boolean {
  if (!file || file === ":memory:" || file.startsWith("file::memory:")) {
    return false;
  }
  if (process.env.COCALC_SQLITE_INLINE_CHECKPOINTS === "1") return false;
  if (isTestRuntime() && !enableInTests) return false;
  let reg = registrations.get(file);
  if (reg == null) {
    reg = {
      file,
      dbs: new Set(),
      maxWalBytes,
      lastSuccessAt: Date.now(),
      inlineFallback: false,
    };
    registrations.set(file, reg);
  } else {
    reg.maxWalBytes = Math.min(reg.maxWalBytes, maxWalBytes);
  }
  reg.dbs.add(db);
  // A connection joining while the file is in fallback checkpoints inline too.
  setAutocheckpoint(reg, db, reg.inlineFallback);
  ensureTimer();
  return true;
}

/**
 * Call before closing a connection passed to deferWalCheckpoints. Without
 * db, forgets every connection to the file.
 */
export function forgetWalCheckpoints(file: string, db?: ExecDatabase): void {
  const reg = registrations.get(file);
  if (reg == null) return;
  if (db != null) {
    reg.dbs.delete(db);
    if (reg.dbs.size > 0) return;
  }
  registrations.delete(file);
  worker?.postMessage({ type: "forget", file });
  if (registrations.size === 0) {
    if (timer != null) {
      clearInterval(timer);
      timer = undefined;
    }
    const w = worker;
    worker = undefined;
    void w?.terminate();
  }
}

// For tests.
export function walCheckpointStatus(
  file: string,
): (Omit<Registration, "dbs"> & { connections: number }) | undefined {
  const reg = registrations.get(file);
  if (reg == null) return undefined;
  const { dbs, ...rest } = reg;
  return { ...rest, connections: dbs.size };
}

export function setCheckpointIntervalForTests(ms: number): void {
  intervalMs = ms;
  if (timer != null) {
    clearInterval(timer);
    timer = undefined;
    if (registrations.size > 0) ensureTimer();
  }
}

export function setCheckpointWorkerEnabledForTests(
  enabled: boolean | "throws",
): void {
  workerMode =
    enabled === true ? "enabled" : enabled === false ? "silent" : "throws";
  if (enabled !== true) {
    const w = worker;
    worker = undefined;
    void w?.terminate();
  }
}
