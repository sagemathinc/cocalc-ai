/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import exec, { parseOutput } from "@cocalc/backend/sandbox/exec";
import { managedRusticSupervisionEnabled } from "@cocalc/backend/sandbox/managed-rustic";
import { RusticJobCleanupError } from "@cocalc/file-server/btrfs/rustic-job-errors";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import { getBtrfsMutationContext } from "@cocalc/file-server/btrfs/operation-cache";
import type { ExecuteCodeStreamEvent } from "@cocalc/util/types/execute-code";
import { parseBackupProducerEvidence } from "@cocalc/backend/backup-producer-evidence";
import type { BackupProducerEvidence } from "@cocalc/backend/backup-producer-evidence";

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

export { managedRusticSupervisionEnabled };

async function waitForRusticJob(
  command: ManagedRusticCommand,
  args: string[],
): Promise<void> {
  const barrier = `${command.replace(/-maintenance$/, "")}-wait`;
  try {
    parseOutput(
      await exec({
        cmd: "/usr/bin/sudo",
        prefixArgs: ["-n", STORAGE_WRAPPER, barrier, ...args],
        timeout: 100_000,
        maxSize: 64 * 1024,
        killProcessGroup: true,
      }),
    );
  } catch (error) {
    throw new RusticJobCleanupError(error);
  }
}

export async function projectRusticBackupWait({
  src,
  repoProfile,
  host,
}: {
  src: string;
  repoProfile: string;
  host: string;
}): Promise<void> {
  if (managedRusticSupervisionEnabled()) {
    await waitForRusticJob("project-rustic-backup", [src, repoProfile, host]);
  }
}

function isBackgroundBtrfsMutation(): boolean {
  const priority = getBtrfsMutationContext().priority;
  return priority === "scheduled" || priority === "scavenger";
}

type ProjectRusticCommand =
  | "project-rustic-backup"
  | "project-rustic-backup-maintenance"
  | "project-rustic-restore";

type ManagedRusticCommand =
  | ProjectRusticCommand
  | "rootfs-rustic-backup"
  | "rootfs-rustic-restore";

export class ProjectRusticUnsupportedError extends Error {
  constructor(
    public readonly command: ProjectRusticCommand,
    message: string,
  ) {
    super(message);
    this.name = "ProjectRusticUnsupportedError";
  }
}

export class PartialProjectBackupError extends Error {
  constructor(
    public readonly backup_id: string,
    public readonly excluded_files: string,
  ) {
    super(
      `Backup saved with ${excluded_files} oversized files excluded. This is not a complete backup and cannot be used to move or archive the project.`,
    );
    this.name = "PartialProjectBackupError";
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
  command: ManagedRusticCommand,
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

// All managed callers share timeout units, strict execution evidence and the
// independent root cleanup barrier. RootFS must not have a direct-sudo bypass.
export async function runManagedRustic({
  command,
  args,
  timeoutMs,
  onProgress,
}: {
  command: ManagedRusticCommand;
  args: string[];
  timeoutMs: number;
  onProgress?: (update: RusticProgressUpdate) => void;
}): Promise<{ stdout: string; stderr: string }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Rustic timeout must be finite and positive");
  }
  if (managedRusticSupervisionEnabled()) {
    try {
      // Never fall back to an unsupervised job when the rollout gate is enabled.
      // This executor rejects partial output and waits for its process to exit;
      // the separate root barrier also covers sudo survivors and caller death.
      return parseOutput(
        await exec({
          cmd: "/usr/bin/sudo",
          prefixArgs: ["-n", STORAGE_WRAPPER, `${command}-supervised`, ...args],
          timeout: timeoutMs,
          maxSize: 8 * 1024 * 1024,
          killProcessGroup: true,
          onStderrLine: onProgress
            ? createRusticProgressHandler({ onProgress })
            : undefined,
        }),
      );
    } finally {
      await waitForRusticJob(command, args);
    }
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
    if (
      command.startsWith("project-") &&
      isUnsupportedCommandError(command, stderr)
    ) {
      throw new ProjectRusticUnsupportedError(
        command as ProjectRusticCommand,
        stderr,
      );
    }
    throw new Error(
      stderr || stdout || `${command} exited with code ${result.exit_code}`,
    );
  }
  return { stdout, stderr };
}

export async function projectRusticBackup({
  src,
  repoProfile,
  host,
  timeoutMs,
  tags,
  parent,
  progress,
  evidence,
}: {
  src: string;
  repoProfile: string;
  host: string;
  timeoutMs: number;
  tags?: string[];
  parent?: string;
  progress?: (update: RusticProgressUpdate) => void;
  evidence?: {
    project_id: string;
    required?: boolean;
    accept: (evidence: BackupProducerEvidence) => Promise<void>;
  };
}): Promise<{
  time: Date;
  id: string;
  summary: { [key: string]: string | number };
}> {
  if (
    evidence &&
    evidence.required !== false &&
    !managedRusticSupervisionEnabled()
  ) {
    throw new Error("Backup evidence requires supervised native execution");
  }
  const tagArgs = (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .flatMap((tag) => ["--tag", tag]);
  const parentArgs = parent ? ["--parent", parent] : [];
  const { stdout } = await runManagedRustic({
    command: isBackgroundBtrfsMutation()
      ? "project-rustic-backup-maintenance"
      : "project-rustic-backup",
    args: [src, repoProfile, host, ...tagArgs, ...parentArgs],
    timeoutMs,
    onProgress: progress,
  });
  const parsed = JSON.parse(stdout);
  if (
    (evidence && evidence.required !== false) ||
    Object.prototype.hasOwnProperty.call(parsed, "cocalc_backup_evidence")
  ) {
    // A mixed-version consumer must never discard new evidence and publish the
    // old unconditional success/freshness signal. Without the durable consumer,
    // leave this operation failed even if a remote snapshot was created.
    if (!evidence)
      throw new Error(
        "Backup evidence consumer is not configured; backup completeness was not recorded",
      );
    if (!managedRusticSupervisionEnabled())
      throw new Error("Backup evidence requires supervised native execution");
    const proof = parseBackupProducerEvidence(
      parsed.cocalc_backup_evidence,
      evidence.project_id,
      parsed.id,
    );
    await evidence.accept(proof);
    if (proof.outcome !== "complete")
      throw new PartialProjectBackupError(parsed.id, proof.excluded_files);
  }
  return {
    time: new Date(parsed.time),
    id: parsed.id,
    summary: parsed.summary ?? {},
  };
}

export async function projectRusticRestore({
  repoProfile,
  snapshot,
  dest,
  timeoutMs,
  progress,
}: {
  repoProfile: string;
  snapshot: string;
  dest: string;
  timeoutMs: number;
  progress?: (update: RusticProgressUpdate) => void;
}): Promise<void> {
  await runManagedRustic({
    command: "project-rustic-restore",
    args: [repoProfile, snapshot, dest],
    timeoutMs,
    onProgress: progress,
  });
}
