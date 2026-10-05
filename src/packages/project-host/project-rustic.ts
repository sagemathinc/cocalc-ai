/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync } from "node:fs";
import { executeCode } from "@cocalc/backend/execute-code";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import { getBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";
import type { OversizedFilesReport } from "@cocalc/util/consts/backups";
import type { ExecuteCodeStreamEvent } from "@cocalc/util/types/execute-code";

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

function isBackgroundBtrfsMutation(): boolean {
  const priority = getBtrfsMutationContext().priority;
  return priority === "scheduled" || priority === "scavenger";
}

type ProjectRusticCommand =
  | "project-rustic-backup"
  | "project-rustic-backup-maintenance"
  | "project-rustic-restore"
  | "project-oversized-files";

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
}: {
  onProgress?: (update: RusticProgressUpdate) => void;
}): {
  env?: Record<string, string>;
  streamCB?: (event: ExecuteCodeStreamEvent) => void;
} {
  if (!onProgress) {
    return {};
  }
  const progressHandler = createRusticProgressHandler({ onProgress });
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
