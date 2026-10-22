/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";

import type {
  PersistMaintenanceFileIdentity,
  PersistMaintenancePageStats,
} from "@cocalc/conat/persist/maintenance/types";

const WORKER_SOURCE = String.raw`
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
      const db = new DatabaseSync(options.sourcePath);
      try {
        db.exec("PRAGMA busy_timeout=5000");
        db.prepare("VACUUM INTO ?").run(options.outputPath);
      } finally {
        db.close();
      }
      outputStats = inspect(options.outputPath, true);
      outputStats.reclaimableBytes = outputStats.pageSize * outputStats.freelistCount;
      if (outputStats.quickCheck !== "ok") {
        throw new Error("compact output quick_check failed: " + outputStats.quickCheck);
      }
      outputIdentity = identity(options.outputPath);
    }
    process.stdout.write(JSON.stringify({
      beforeIdentity,
      beforeStats,
      outputIdentity,
      outputStats,
    }));
  } catch (err) {
    process.stderr.write(String(err && err.stack || err));
    process.exitCode = 1;
  }
});
`;

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
          if (timedOut) {
            reject(
              new Error(
                `SQLite maintenance worker timed out after ${timeoutMs}ms`,
              ),
            );
            return;
          }
          if (code !== 0) {
            reject(
              new Error(
                `SQLite maintenance worker failed code=${code} signal=${signal}: ${stderr.slice(0, 8000)}`,
              ),
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout) as PersistMaintenanceWorkerResult);
          } catch (err) {
            reject(
              new Error(`invalid SQLite maintenance worker result: ${err}`),
            );
          }
        });
      });
      child.stdin.end(JSON.stringify({ sourcePath, outputPath }));
    },
  );
}
