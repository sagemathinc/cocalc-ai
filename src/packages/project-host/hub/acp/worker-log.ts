/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The ACP worker writes to logs/acp-worker.log for as long as it runs, which can
be days, and nothing else bounds that file: on alpha it reached 1.5 GB and
helped fill the data disk. The worker holds the file open in append mode, so
the file can be truncated in place (copytruncate): the worker's next write
lands at the new end. Before truncating, the last part of the file is kept in
log-history/, next to the archived logs of the other project-host components,
and only the newest few archives are kept.
*/

import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rm, stat, truncate } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export const ACP_WORKER_LOG_HISTORY_PREFIX = "acp-worker-";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_KEEP = 5;
// Out of space: archiving cannot work, but the live log must still be bounded.
const NO_SPACE_CODES = new Set(["ENOSPC", "EDQUOT"]);

export type AcpWorkerLogCap =
  | { outcome: "archived"; archive: string }
  | { outcome: "truncated-without-archive"; error: string };

async function copyTail(
  src: string,
  dest: string,
  start: number,
  end: number,
): Promise<void> {
  await pipeline(
    createReadStream(src, { start, end }),
    createWriteStream(dest, { flags: "wx", mode: 0o600 }),
  );
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function acpWorkerLogMaxBytes(): number {
  return positiveIntEnv(
    "COCALC_PROJECT_HOST_ACP_WORKER_LOG_MAX_BYTES",
    DEFAULT_MAX_BYTES,
  );
}

/** The same limit as the other project-host component logs. */
export function acpWorkerLogHistoryKeep(): number {
  return Math.min(
    50,
    positiveIntEnv("COCALC_PROJECT_HOST_LOG_HISTORY_LIMIT", DEFAULT_KEEP),
  );
}

/**
 * If logPath is over maxBytes, keep its last maxBytes in historyDir and
 * truncate it in place. Returns undefined if the log was small enough (or
 * missing). Lines the worker writes between the copy and the truncation are
 * lost; that window is short and this is a debug log.
 *
 * A failed copy never leaves a partial archive. If it failed for lack of
 * space, the log is truncated anyway (outcome "truncated-without-archive"):
 * a full disk is when bounding it matters most. Any other failure leaves the
 * log alone and throws.
 */
export async function capAcpWorkerLog({
  logPath,
  historyDir,
  maxBytes = acpWorkerLogMaxBytes(),
  keep = acpWorkerLogHistoryKeep(),
  now = new Date(),
  copy = copyTail,
}: {
  logPath: string;
  historyDir: string;
  maxBytes?: number;
  keep?: number;
  now?: Date;
  /** For tests. */
  copy?: typeof copyTail;
}): Promise<AcpWorkerLogCap | undefined> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (size <= maxBytes) return;

  try {
    await mkdir(historyDir, { recursive: true, mode: 0o700 });
  } catch (err: any) {
    if (!NO_SPACE_CODES.has(err?.code)) throw err;
    await truncate(logPath, 0);
    return { outcome: "truncated-without-archive", error: `${err}` };
  }
  const base = `${ACP_WORKER_LOG_HISTORY_PREFIX}${now
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  const archived = new Set(await readdir(historyDir));
  let name = `${base}.log`;
  for (let suffix = 1; archived.has(name); suffix += 1) {
    name = `${base}-${suffix}.log`;
  }
  const archivePath = path.join(historyDir, name);
  // Copy only the tail: a log that grew far past the limit (before this
  // existed, or between checks) is not copied whole.
  let result: AcpWorkerLogCap;
  try {
    await copy(logPath, archivePath, size - maxBytes, size - 1);
    await chmod(archivePath, 0o600).catch(() => {});
    result = { outcome: "archived", archive: archivePath };
  } catch (err: any) {
    // Never keep a partial archive; a failed removal must not hide err.
    await rm(archivePath, { force: true }).catch(() => {});
    if (!NO_SPACE_CODES.has(err?.code)) throw err;
    result = { outcome: "truncated-without-archive", error: `${err}` };
  }
  await truncate(logPath, 0);

  const old = (await readdir(historyDir))
    .filter(
      (entry) =>
        entry.startsWith(ACP_WORKER_LOG_HISTORY_PREFIX) &&
        entry.endsWith(".log"),
    )
    .sort()
    .reverse()
    .slice(keep);
  for (const entry of old) {
    await rm(path.join(historyDir, entry), { force: true });
  }
  return result;
}
