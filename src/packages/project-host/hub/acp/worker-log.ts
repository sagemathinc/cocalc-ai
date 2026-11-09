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
 * truncate it in place. Returns the archive's path, or undefined if the log
 * was small enough (or missing). Lines the worker writes between the copy and
 * the truncation are lost; that window is short and this is a debug log.
 */
export async function capAcpWorkerLog({
  logPath,
  historyDir,
  maxBytes = acpWorkerLogMaxBytes(),
  keep = acpWorkerLogHistoryKeep(),
  now = new Date(),
}: {
  logPath: string;
  historyDir: string;
  maxBytes?: number;
  keep?: number;
  now?: Date;
}): Promise<string | undefined> {
  let size: number;
  try {
    size = (await stat(logPath)).size;
  } catch (err: any) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  if (size <= maxBytes) return;

  await mkdir(historyDir, { recursive: true, mode: 0o700 });
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
  await pipeline(
    createReadStream(logPath, { start: size - maxBytes, end: size - 1 }),
    createWriteStream(archivePath, { flags: "wx", mode: 0o600 }),
  );
  await chmod(archivePath, 0o600).catch(() => {});
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
  return archivePath;
}
