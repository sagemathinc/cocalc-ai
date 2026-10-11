/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `exec` in direct mode: one command in the user's login shell, in its own
// process group, stdin closed unless given, a timeout, and at most 1 MB of
// output returned. The full output stays on the machine.
// Plan: src/.agents/computers-plan-2026-10-11.md ("How it looks to the agent").

import { spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  MAX_EXEC_OUTPUT_BYTES,
  type ExecRequest,
} from "@cocalc/util/computers/operations";
import { ensurePrivateDir } from "./durable";

export interface ExecResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  /** The session ended (or the daemon stopped it) while it ran. */
  cancelled: boolean;
  stdout: string;
  stderr: string;
  /** Output beyond the returned bytes is only in the files on the machine. */
  truncated: boolean;
  duration_ms: number;
}

/** Each of stdout and stderr keeps at most this much on the machine. */
export const EXEC_FILE_CAP_BYTES = 64 * 1024 * 1024;

export interface ExecOptions {
  /** The computer's default working directory. */
  workdir: string;
  /** Where the full stdout and stderr are written. */
  logDir: string;
  shell?: string;
  maxOutputBytes?: number;
  /** Cap on each output file kept on the machine. */
  fileCapBytes?: number;
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Called with the process (group) id once it started. */
  onSpawn?: (pid: number) => void;
}

/** A cwd relative to the working directory, or absolute; it must exist. */
export function resolveCwd(workdir: string, cwd: string | null): string {
  const dir =
    cwd == null ? workdir : isAbsolute(cwd) ? cwd : resolve(workdir, cwd);
  let ok = false;
  try {
    ok = statSync(dir).isDirectory();
  } catch {}
  if (!ok) throw new Error(`no such directory on this computer: ${dir}`);
  return dir;
}

export function loginShell(): string {
  return process.env.SHELL || "/bin/sh";
}

/** Kill a process group: SIGTERM, then SIGKILL after the grace period. */
export function killGroup(pid: number, graceMs: number): void {
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {}
  };
  send("SIGTERM");
  const timer = setTimeout(() => send("SIGKILL"), graceMs);
  timer.unref();
}

export async function runExec(
  request: ExecRequest,
  opts: ExecOptions,
): Promise<ExecResult> {
  const cwd = resolveCwd(opts.workdir, request.cwd);
  const max = opts.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
  const grace = opts.killGraceMs ?? 5000;
  ensurePrivateDir(opts.logDir);
  const files = {
    stdout: createWriteStream(join(opts.logDir, "stdout"), { mode: 0o600 }),
    stderr: createWriteStream(join(opts.logDir, "stderr"), { mode: 0o600 }),
  };
  const started = Date.now();
  const child = spawn(opts.shell ?? loginShell(), ["-lc", request.command], {
    cwd,
    env: opts.env ?? process.env,
    detached: true, // its own process group, so a timeout kills the tree
    stdio: [request.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
  });

  if (child.pid != null) opts.onSpawn?.(child.pid);
  const kept: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  };
  let budget = max;
  let truncated = false;
  const fileCap = opts.fileCapBytes ?? EXEC_FILE_CAP_BYTES;
  const written = { stdout: 0, stderr: 0 };
  for (const name of ["stdout", "stderr"] as const) {
    child[name]!.on("data", (chunk: Buffer) => {
      // Past the cap the output is still read (so the command never blocks
      // or dies of a closed pipe) but no longer kept.
      if (written[name] < fileCap) {
        const part = chunk.subarray(0, fileCap - written[name]);
        files[name].write(part);
        written[name] += part.length;
      }
      if (budget > 0) {
        const part = chunk.subarray(0, budget);
        kept[name].push(part);
        budget -= part.length;
        if (part.length < chunk.length) truncated = true;
      } else {
        truncated = true;
      }
    });
  }
  if (request.stdin != null) {
    child.stdin!.on("error", () => {}); // the command may not read it
    child.stdin!.end(Buffer.from(request.stdin, "base64"));
  }

  let timedOut = false;
  let cancelled = false;
  const stop = () => {
    if (child.pid != null) killGroup(child.pid, grace);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, request.timeout_ms);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) onAbort();

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  }).finally(() => {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  });
  await Promise.all(
    Object.values(files).map(
      (f) => new Promise<void>((done) => f.end(() => done())),
    ),
  );
  return {
    exit_code: code,
    signal,
    timed_out: timedOut,
    cancelled,
    stdout: Buffer.concat(kept.stdout).toString("utf8"),
    stderr: Buffer.concat(kept.stderr).toString("utf8"),
    truncated,
    duration_ms: Date.now() - started,
  };
}
