/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { executeCode } from "@cocalc/backend/execute-code";
import {
  createRusticProgressHandler,
  type RusticProgressUpdate,
} from "@cocalc/file-server/btrfs/rustic-progress";
import type { ExecuteCodeStreamEvent } from "@cocalc/util/types/execute-code";

const STORAGE_WRAPPER = "/usr/local/sbin/cocalc-runtime-storage";

type ProjectRusticCommand = "project-rustic-backup" | "project-rustic-restore";

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

export async function projectRusticBackup({
  src,
  repoProfile,
  host,
  timeoutMs,
  tags,
  progress,
}: {
  src: string;
  repoProfile: string;
  host: string;
  timeoutMs: number;
  tags?: string[];
  progress?: (update: RusticProgressUpdate) => void;
}): Promise<{
  time: Date;
  id: string;
  summary: { [key: string]: string | number };
}> {
  const tagArgs = (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .flatMap((tag) => ["--tag", tag]);
  const { stdout } = await runProjectRustic({
    command: "project-rustic-backup",
    args: [src, repoProfile, host, ...tagArgs],
    timeoutMs,
    onProgress: progress,
  });
  const parsed = JSON.parse(stdout);
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
  await runProjectRustic({
    command: "project-rustic-restore",
    args: [repoProfile, snapshot, dest],
    timeoutMs,
    onProgress: progress,
  });
}
