/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync } from "node:fs";
import { executeCode } from "@cocalc/backend/execute-code";
import getLogger from "@cocalc/backend/logger";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import { getBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";
import type { OversizedFilesReport } from "@cocalc/util/consts/backups";
import type { ExecuteCodeStreamEvent } from "@cocalc/util/types/execute-code";

const logger = getLogger("project-host:project-rustic");

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

// A background backup can need far longer than its time budget: rustic reads
// every file it can't match with its parent, at the maintenance cgroup's I/O
// cap, and a killed attempt starts reading from the beginning again. Past its
// budget it keeps running while rustic reports progress, and is stopped once
// progress stalls this long, or at the ceiling (the privileged helper's own
// limit).
export const BACKUP_STALL_MS = 10 * 60_000;
export const BACKUP_CEILING_MS = 12 * 60 * 60_000;
const BACKUP_WATCHDOG_INTERVAL_MS = 30_000;
// rustic prints progress every second: hours of it fit with room to spare.
// Past this, output (and with it progress) would no longer be seen.
const WATCHED_MAX_OUTPUT = 64 * 1024 * 1024;

const watchdogLimits = {
  stallMs: BACKUP_STALL_MS,
  ceilingMs: BACKUP_CEILING_MS,
  intervalMs: BACKUP_WATCHDOG_INTERVAL_MS,
};

function isBackgroundBtrfsMutation(): boolean {
  const priority = getBtrfsMutationContext().priority;
  return priority === "scheduled" || priority === "scavenger";
}

type ProjectRusticCommand =
  | "project-rustic-backup"
  | "project-rustic-backup-maintenance"
  | "project-rustic-restore"
  | "project-oversized-files"
  | "project-changed-since";

export class ProjectRusticUnsupportedError extends Error {
  constructor(
    public readonly command: ProjectRusticCommand,
    message: string,
  ) {
    super(message);
    this.name = "ProjectRusticUnsupportedError";
  }
}

function createRusticStreamHooks({
  onProgress,
  onLine,
}: {
  onProgress?: (update: RusticProgressUpdate) => void;
  onLine?: (line: string) => void;
}): {
  env?: Record<string, string>;
  streamCB?: (event: ExecuteCodeStreamEvent) => void;
} {
  if (!onProgress && !onLine) {
    return {};
  }
  const progress = onProgress
    ? createRusticProgressHandler({ onProgress })
    : undefined;
  const progressHandler = (line: string) => {
    progress?.(line);
    onLine?.(line);
  };
  let stderrBuffer = "";
  return {
    env: { RUSTIC_PROGRESS_INTERVAL: "1s" },
    streamCB: (event) => {
      if (event.type === "stderr" && typeof event.data === "string") {
        stderrBuffer += event.data.replace(/\r/g, "\n");
        const parts = stderrBuffer.split("\n");
        stderrBuffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (line) {
            progressHandler(line);
          }
        }
        return;
      }
      if (event.type === "done") {
        const line = stderrBuffer.trim();
        stderrBuffer = "";
        if (line) {
          progressHandler(line);
        }
      }
    },
  };
}

function toTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

function isUnsupportedCommandError(
  command: ProjectRusticCommand,
  stderr: string,
): boolean {
  if (
    command.startsWith("project-rustic-backup") &&
    stderr.includes("SECURITY_DENY") &&
    stderr.includes("project-rustic-backup-bad-args") &&
    stderr.includes("detail=--parent")
  ) {
    return true;
  }
  return (
    stderr.includes("SECURITY_DENY") &&
    stderr.includes("unsupported-command") &&
    stderr.includes(command)
  );
}

async function runProjectRustic({
  command,
  args,
  timeoutMs,
  onProgress,
}: {
  command: ProjectRusticCommand;
  args: string[];
  timeoutMs: number;
  onProgress?: (update: RusticProgressUpdate) => void;
}): Promise<{ stdout: string; stderr: string }> {
  if (command === "project-rustic-backup-maintenance") {
    return await runWatchedBackup({ command, args, timeoutMs, onProgress });
  }
  const hooks = createRusticStreamHooks({ onProgress });
  const result = await executeCode({
    verbose: false,
    err_on_exit: false,
    timeout: toTimeoutSeconds(timeoutMs),
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, command, ...args],
    env: hooks.env,
    streamCB: hooks.streamCB,
  });
  if (result.type !== "blocking") {
    throw new Error(`${command} must run in blocking mode`);
  }
  const stdout = `${result.stdout ?? ""}`;
  const stderr = `${result.stderr ?? ""}`;
  if (result.exit_code !== 0) {
    if (isUnsupportedCommandError(command, stderr)) {
      throw new ProjectRusticUnsupportedError(command, stderr);
    }
    throw new Error(
      stderr || stdout || `${command} exited with code ${result.exit_code}`,
    );
  }
  return { stdout, stderr };
}

// A background backup, past its budget, runs on while rustic's progress
// advances (see BACKUP_STALL_MS).
async function runWatchedBackup({
  command,
  args,
  timeoutMs,
  onProgress,
}: {
  command: ProjectRusticCommand;
  args: string[];
  timeoutMs: number;
  onProgress?: (update: RusticProgressUpdate) => void;
}): Promise<{ stdout: string; stderr: string }> {
  const { stallMs, ceilingMs, intervalMs } = watchdogLimits;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastProgress: string | undefined;
  // the furthest value seen for each of rustic's progress lines
  const furthest = new Map<string, number>();
  const watch = createRusticProgressHandler({
    minIntervalMs: 0,
    onProgress: ({ message, detail }) => {
      lastProgress = message;
      const key = detail?.prefix ?? message;
      const value = detail?.bytes_done ?? detail?.count_done ?? 0;
      if (!furthest.has(key) || value > furthest.get(key)!) {
        furthest.set(key, value);
        lastProgressAt = Date.now();
      }
    },
  });
  const hooks = createRusticStreamHooks({ onProgress, onLine: watch });
  const started = await executeCode({
    verbose: false,
    err_on_exit: false,
    async_call: true,
    max_output: WATCHED_MAX_OUTPUT,
    timeout: toTimeoutSeconds(Math.max(timeoutMs, ceilingMs)),
    command: "sudo",
    args: ["-n", STORAGE_WRAPPER, command, ...args],
    env: hooks.env,
    streamCB: hooks.streamCB,
  });
  if (started.type !== "async") {
    throw new Error(`${command} did not start asynchronously`);
  }
  let stalled = false;
  const timer = setInterval(() => {
    // the stall window starts at the budget's end at the earliest, so a run
    // quiet then (an index load, say) still gets all of it
    const quietSince = Math.max(lastProgressAt, startedAt + timeoutMs);
    if (Date.now() - quietSince < stallMs) return;
    stalled = true;
    clearInterval(timer);
    executeCode({ async_cancel: started.job_id }).catch((err) =>
      logger.warn("unable to stop a stalled backup", {
        command,
        err: `${err}`,
      }),
    );
  }, intervalMs);
  let result;
  try {
    result = await executeCode({
      async_get: started.job_id,
      async_await: true,
    });
  } finally {
    clearInterval(timer);
  }
  if (result.type !== "async") {
    throw new Error(`${command} returned an invalid result`);
  }
  const elapsedMs = Date.now() - startedAt;
  const stdout = `${result.stdout ?? ""}`;
  const stderr = `${result.stderr ?? ""}`;
  if (result.status === "completed" && result.exit_code === 0) {
    return { stdout, stderr };
  }
  if (isUnsupportedCommandError(command, stderr)) {
    throw new ProjectRusticUnsupportedError(command, stderr);
  }
  const why = stalled
    ? `no progress for ${Math.round(stallMs / 60_000)} min after its ${Math.round(timeoutMs / 60_000)} min budget`
    : result.status === "killed" || elapsedMs >= ceilingMs
      ? `stopped at the ${Math.round(ceilingMs / 3_600_000)} h ceiling`
      : `exited with code ${result.exit_code}`;
  logger.warn("background backup did not finish", {
    command,
    why,
    elapsed_ms: elapsedMs,
    last_progress: lastProgress,
  });
  throw new Error(
    `${command} ${why} (after ${Math.round(elapsedMs / 60_000)} min; last progress: ${lastProgress ?? "none"})${stderr ? `: ${stderr.slice(-4000)}` : ""}`,
  );
}

// The privileged helper prints this line when the backup skipped files larger
// than its limit. The snapshot description records the same report.
const OVERSIZED_FILES_MARKER = "COCALC_BACKUP_OVERSIZED_FILES ";

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// A sparse file's length can exceed 2^53 (up to about 8 EiB) while using no
// disk. Such sizes only lose precision, which is fine for display.
function isApparentSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseOversizedFilesReport(
  stderr: string,
): OversizedFilesReport | undefined {
  const line = stderr
    .split("\n")
    .find((line) => line.startsWith(OVERSIZED_FILES_MARKER));
  if (line == null) return;
  return validateOversizedFilesReport(
    line.slice(OVERSIZED_FILES_MARKER.length),
  );
}

function validateOversizedFilesReport(json: string): OversizedFilesReport {
  let report: any;
  try {
    report = JSON.parse(json);
  } catch {
    report = undefined;
  }
  if (
    !isNonNegativeInteger(report?.max_file_bytes) ||
    !isNonNegativeInteger(report?.count) ||
    !Array.isArray(report?.files) ||
    !report.files.every(
      (file: any) =>
        typeof file?.path === "string" && isApparentSize(file?.size),
    )
  ) {
    // Never treat an unreadable report as "nothing was skipped".
    throw new Error(`malformed oversized file report: ${json.slice(0, 500)}`);
  }
  return {
    max_file_bytes: report.max_file_bytes,
    count: report.count,
    files: report.files.map(({ path, size }) => ({ path, size })),
  };
}

function isUnsupportedMaxFileBytesError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err}`;
  return (
    message.includes("SECURITY_DENY") &&
    message.includes("project-rustic-backup-bad-args") &&
    message.includes("detail=--max-file-bytes")
  );
}

export async function projectRusticBackup({
  src,
  repoProfile,
  host,
  timeoutMs,
  tags,
  parent,
  maxFileBytes,
  progress,
}: {
  src: string;
  repoProfile: string;
  host: string;
  timeoutMs: number;
  tags?: string[];
  parent?: string;
  maxFileBytes?: number;
  progress?: (update: RusticProgressUpdate) => void;
}): Promise<{
  time: Date;
  id: string;
  summary: { [key: string]: string | number };
  oversized_files?: OversizedFilesReport;
}> {
  const tagArgs = (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .flatMap((tag) => ["--tag", tag]);
  const parentArgs = parent ? ["--parent", parent] : [];
  const maxFileArgs =
    maxFileBytes == null ? [] : ["--max-file-bytes", `${maxFileBytes}`];
  const run = async (extraArgs: string[]) =>
    await runProjectRustic({
      command: isBackgroundBtrfsMutation()
        ? "project-rustic-backup-maintenance"
        : "project-rustic-backup",
      args: [src, repoProfile, host, ...tagArgs, ...parentArgs, ...extraArgs],
      timeoutMs,
      onProgress: progress,
    });
  let output: { stdout: string; stderr: string };
  try {
    output = await run(maxFileArgs);
  } catch (err) {
    // A host whose bootstrap predates the limit rejects the option before
    // doing any work; it also applies no limit, as before.
    if (maxFileArgs.length === 0 || !isUnsupportedMaxFileBytesError(err)) {
      throw err;
    }
    output = await run([]);
  }
  const parsed = JSON.parse(output.stdout);
  logger.info("rustic backup finished", {
    host,
    id: parsed.id,
    summary: parsed.summary,
  });
  return {
    time: new Date(parsed.time),
    id: parsed.id,
    summary: parsed.summary ?? {},
    oversized_files: parseOversizedFilesReport(output.stderr),
  };
}

export async function projectRusticRestore({
  repoProfile,
  snapshot,
  dest,
  timeoutMs,
  progress,
  remote_only = false,
}: {
  repoProfile: string;
  snapshot: string;
  dest: string;
  timeoutMs: number;
  progress?: (update: RusticProgressUpdate) => void;
  remote_only?: boolean;
}): Promise<void> {
  await runProjectRustic({
    command: "project-rustic-restore",
    args: [repoProfile, snapshot, dest, ...(remote_only ? ["--no-cache"] : [])],
    timeoutMs,
    onProgress: progress,
  });
}

// List files a backup of src would skip, optionally only beneath the given
// src-relative paths. Returns null on hosts whose privileged helper predates
// the size limit: their backups do not skip anything.
export async function projectOversizedFiles({
  src,
  maxFileBytes,
  subpaths = [],
  timeoutMs = 10 * 60_000,
}: {
  src: string;
  maxFileBytes: number;
  subpaths?: string[];
  timeoutMs?: number;
}): Promise<OversizedFilesReport | null> {
  if (!existsSync(STORAGE_WRAPPER)) {
    // Development and Lite hosts back up without the privileged helper.
    return null;
  }
  try {
    const { stdout } = await runProjectRustic({
      command: "project-oversized-files",
      args: [
        src,
        "--max-file-bytes",
        `${maxFileBytes}`,
        ...subpaths.flatMap((path) => ["--subpath", path]),
      ],
      timeoutMs,
    });
    return validateOversizedFilesReport(stdout.trim());
  } catch (err) {
    if (err instanceof ProjectRusticUnsupportedError) {
      return null;
    }
    throw err;
  }
}

// src-relative paths whose ctime is at or after sinceMs ("." for src itself),
// without reading any file: only the first few, and truncated if there were
// more. foreign_filesystem: the walk met a nested subvolume or mount, whose
// changes it can't see. Null where the privileged helper is missing or
// predates this scan.
export async function projectChangedSince({
  src,
  sinceMs,
  timeoutMs = 90_000,
}: {
  src: string;
  sinceMs: number;
  timeoutMs?: number;
}): Promise<{
  paths: string[];
  truncated: boolean;
  foreign_filesystem: boolean;
} | null> {
  if (!existsSync(STORAGE_WRAPPER)) return null;
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
    throw new Error(`invalid change scan time: ${sinceMs}`);
  }
  try {
    const { stdout } = await runProjectRustic({
      command: "project-changed-since",
      args: [src, "--since-ns", `${BigInt(sinceMs) * 1_000_000n}`],
      timeoutMs,
    });
    const report = JSON.parse(stdout.trim());
    if (
      !Array.isArray(report?.paths) ||
      !report.paths.every((path: unknown) => typeof path === "string") ||
      typeof report.truncated !== "boolean" ||
      typeof report.foreign_filesystem !== "boolean"
    ) {
      throw new Error("invalid change scan report");
    }
    return {
      paths: report.paths,
      truncated: report.truncated,
      foreign_filesystem: report.foreign_filesystem,
    };
  } catch (err) {
    if (err instanceof ProjectRusticUnsupportedError) return null;
    throw err;
  }
}

export const __test__ = {
  setWatchdogLimits(limits: Partial<typeof watchdogLimits>) {
    Object.assign(watchdogLimits, limits);
  },
  resetWatchdogLimits() {
    watchdogLimits.stallMs = BACKUP_STALL_MS;
    watchdogLimits.ceilingMs = BACKUP_CEILING_MS;
    watchdogLimits.intervalMs = BACKUP_WATCHDOG_INTERVAL_MS;
  },
};
