/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";

import { MaintenanceCompletionUnprovenError } from "../persist-durability";
import type {
  PersistMaintenanceFileIdentity,
  PersistMaintenancePageStats,
} from "@cocalc/conat/persist/maintenance/types";

// (exported for the worker's own tests, which run it under a preload)
export const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const { DatabaseSync } = require("node:sqlite");

function scalar(db, pragma) {
  const row = db.prepare(pragma).get();
  return Number(Object.values(row)[0]);
}

function inspect(path, readOnly) {
  const db = new DatabaseSync(path, { readOnly });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const quick = db.prepare("PRAGMA quick_check").get();
    return {
      pageSize: scalar(db, "PRAGMA page_size"),
      pageCount: scalar(db, "PRAGMA page_count"),
      freelistCount: scalar(db, "PRAGMA freelist_count"),
      quickCheck: String(Object.values(quick)[0]),
    };
  } finally {
    db.close();
  }
}

function identity(path) {
  const stat = fs.lstatSync(path);
  let walSizeBytes = 0;
  try { walSizeBytes = fs.lstatSync(path + "-wal").size; } catch {}
  return {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    walSizeBytes,
  };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  // (028 SA-B2-3) where a failure happened, for the parent: "before-open"
  // (the source not yet opened read-write: nothing written), "source-open"
  // (opened read-write and not closed after its explicit checkpoint: its
  // close may have checkpointed, unreported), "source-closed" (checkpointed
  // and closed: the source is settled)
  let phase = "before-open";
  try {
    try { os.setPriority(10); } catch {}
    const options = JSON.parse(input);
    const beforeIdentity = identity(options.sourcePath);
    const beforeStats = inspect(options.sourcePath, true);
    beforeStats.reclaimableBytes = beforeStats.pageSize * beforeStats.freelistCount;
    if (beforeStats.quickCheck !== "ok") {
      throw new Error("source quick_check failed: " + beforeStats.quickCheck);
    }
    let outputIdentity;
    let outputStats;
    if (options.outputPath) {
      if (fs.existsSync(options.outputPath)) {
        throw new Error("compact output already exists");
      }
      // (an open that fails is still before-open: nothing was opened)
      const db = new DatabaseSync(options.sourcePath);
      phase = "source-open";
      try {
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare("VACUUM INTO ?").run(options.outputPath);
        // this read-write connection may be the source's last one: an
        // explicit checkpoint surfaces a sync error, and leaves the close
        // nothing to write -- only if it is COMPLETE (088): busy 0, log and
        // checkpointed equal integers; else it throws here, phase still
        // source-open (unproven)
        const ck = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() || {};
        if (ck.busy !== 0 || !Number.isInteger(ck.log) || !Number.isInteger(ck.checkpointed) || ck.log !== ck.checkpointed) {
          throw new Error("source WAL checkpoint incomplete (busy=" + ck.busy + " log=" + ck.log + " checkpointed=" + ck.checkpointed + ")");
        }
      } catch (err) {
        try { db.close(); } catch (closeErr) {
          if (closeErr && (closeErr.errcode === 1034 || closeErr.errcode === 1290)) throw closeErr;
        }
        throw err;
      }
      db.close();
      phase = "source-closed";
      outputStats = inspect(options.outputPath, true);
      outputStats.reclaimableBytes = outputStats.pageSize * outputStats.freelistCount;
      if (outputStats.quickCheck !== "ok") {
        throw new Error("compact output quick_check failed: " + outputStats.quickCheck);
      }
      outputIdentity = identity(options.outputPath);
    }
    process.stdout.write(JSON.stringify({
      ok: true,
      result: { beforeIdentity, beforeStats, outputIdentity, outputStats },
    }));
  } catch (err) {
    // the report is stdout's ONLY content (warnings go to stderr)
    const errcode = err && (err.errcode === 1034 || err.errcode === 1290) ? err.errcode : null;
    process.stdout.write(JSON.stringify({ ok: false, phase, errcode }));
    process.stderr.write(String(err && err.stack || err));
    process.exitCode = 1;
  }
});
`;

// How a worker run ends (028 SA-B2-3; strict, from stdout only):
// - exit 0 with exactly {ok: true, result}: the result;
// - a failure report {ok: false, phase, errcode}: a SQLite sync errcode
//   (1034, 1290) -> an Error with that errcode (the caller poisons); phase
//   "before-open" or "source-closed" -> a plain Error (the source is settled:
//   disarmed); phase "source-open" -> unproven;
// - killed, timed out, or anything else (no report, a malformed or partial
//   one): MaintenanceCompletionUnprovenError (the record stays armed).
export function workerOutcome({
  code,
  signal,
  timedOut,
  timeoutMs,
  stdout,
  stderr,
  sourcePath,
}: {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  timeoutMs: number;
  stdout: string;
  stderr: string;
  sourcePath: string;
}): { result: PersistMaintenanceWorkerResult } | { error: Error } {
  const unproven = (why: string) => ({
    error: new MaintenanceCompletionUnprovenError(sourcePath, why),
  });
  if (timedOut) return unproven(`SQLite maintenance worker timed out after ${timeoutMs}ms`);
  if (code == null) return unproven(`SQLite maintenance worker killed by ${signal}`);
  let report: any;
  try {
    report = JSON.parse(stdout);
  } catch {
    return unproven(`no parseable worker report (code=${code}): ${stderr.slice(0, 2000)}`);
  }
  // (AS-B2-WORKER-NULL-1) only a plain object is a report: null, a scalar or an
  // array proves nothing (and is never dereferenced)
  if (report === null || typeof report != "object" || Array.isArray(report)) {
    return unproven(`a worker report that is not an object (code=${code}): ${stdout.slice(0, 200)}`);
  }
  const keys = Object.keys(report).sort().join(",");
  if (code === 0 && report.ok === true && keys === "ok,result" && report.result != null && typeof report.result == "object" && !Array.isArray(report.result)) {
    return { result: report.result as PersistMaintenanceWorkerResult };
  }
  if (code !== 0 && report.ok === false && keys === "errcode,ok,phase") {
    const why = `SQLite maintenance worker failed (code=${code}, phase ${report.phase}): ${stderr.slice(0, 8000)}`;
    if (report.errcode === 1034 || report.errcode === 1290) {
      return { error: Object.assign(new Error(why), { errcode: report.errcode }) };
    }
    if (report.errcode === null && (report.phase === "before-open" || report.phase === "source-closed")) {
      return { error: new Error(why) };
    }
    if (report.errcode === null && report.phase === "source-open") {
      return unproven(why);
    }
  }
  return unproven(`a malformed worker report (code=${code}): ${stdout.slice(0, 500)}`);
}

export interface PersistMaintenanceWorkerResult {
  beforeIdentity: PersistMaintenanceFileIdentity;
  beforeStats: PersistMaintenancePageStats;
  outputIdentity?: PersistMaintenanceFileIdentity;
  outputStats?: PersistMaintenancePageStats;
}

export async function runPersistMaintenanceWorker({
  sourcePath,
  outputPath,
  timeoutMs,
}: {
  sourcePath: string;
  outputPath?: string;
  timeoutMs: number;
}): Promise<PersistMaintenanceWorkerResult> {
  return await new Promise<PersistMaintenanceWorkerResult>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["-e", WORKER_SOURCE], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      // Settled only once the child has exited: until then it may still have
      // the databases open (the coordinator holds its claim on them until
      // this settles, conat/persist/fence.ts claimPersistFile).
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) => {
        // a child that never started; one that did settles when it exits
        if (child.pid == null) finish(() => reject(err));
      });
      child.on("exit", (code, signal) => {
        finish(() => {
          let outcome: ReturnType<typeof workerOutcome>;
          try {
            outcome = workerOutcome({
              code,
              signal,
              timedOut,
              timeoutMs,
              stdout,
              stderr,
              sourcePath,
            });
          } catch (err) {
            // never an uncaught exception from the exit callback: unproven
            outcome = {
              error: new MaintenanceCompletionUnprovenError(sourcePath, `classifying the worker report: ${err}`),
            };
          }
          if ("error" in outcome) reject(outcome.error);
          else resolve(outcome.result);
        });
      });
      child.stdin.end(JSON.stringify({ sourcePath, outputPath }));
    },
  );
}
