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
import { RELEASE_PRELUDE, STAY_LEADER, type SpawnedChild } from "./launch";
import type { Writable } from "node:stream";

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
  /** Called with the process (its group's leader) once it started. */
  onSpawn?: (child: SpawnedChild) => void;
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

/**
 * Kill the process group of a child this daemon spawned and still holds:
 * SIGTERM, then SIGKILL after the grace period unless it is gone by then
 * (its leader stays while the group lives, so the id is still ours).
 */
export function killGroup(
  pid: number,
  graceMs: number,
  gone: () => boolean = () => false,
): void {
  const send = (signal: NodeJS.Signals) => {
    if (gone()) return;
    try {
      process.kill(-pid, signal);
    } catch {}
  };
  send("SIGTERM");
  const timer = setTimeout(() => send("SIGKILL"), graceMs);
  timer.unref();
}

/**
 * The exec wrapper: waits for the release on fd 3, runs the command in the
 * login shell with the given stdin, survives SIGTERM itself, and (Linux)
 * stays the group's leader until the group is empty (see launch.ts).
 */
const EXEC_WRAPPER = `${RELEASE_PRELUDE}
cmd=$COCALC_EXEC_COMMAND
exec_shell=$COCALC_EXEC_SHELL
unset COCALC_EXEC_COMMAND COCALC_EXEC_SHELL
trap '' TERM HUP INT
exec 4<&0
( trap - TERM HUP INT; exec "$exec_shell" -lc "$cmd" ) <&4 4<&- &
child=$!
exec 4<&- </dev/null
wait "$child"
code=$?
${STAY_LEADER}
exit "$code"
`;

export class ExecNotStarted extends Error {}

export async function runExec(
  request: ExecRequest,
  opts: ExecOptions,
): Promise<ExecResult> {
  const cwd = resolveCwd(opts.workdir, request.cwd);
  const max = opts.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
  const grace = opts.killGraceMs ?? 5000;
  ensurePrivateDir(opts.logDir);
  // Output files that stop (instead of crashing the daemon) if the disk is
  // full; the command's output is still read and counted.
  const files = {
    stdout: createWriteStream(join(opts.logDir, "stdout"), { mode: 0o600 }),
    stderr: createWriteStream(join(opts.logDir, "stderr"), { mode: 0o600 }),
  };
  const broken = { stdout: false, stderr: false };
  for (const name of ["stdout", "stderr"] as const) {
    files[name].on("error", () => {
      broken[name] = true;
    });
  }
  const started = Date.now();
  const child = spawn("/bin/sh", ["-c", EXEC_WRAPPER, "cocalc-exec"], {
    cwd,
    env: {
      ...(opts.env ?? process.env),
      COCALC_EXEC_COMMAND: request.command,
      COCALC_EXEC_SHELL: opts.shell ?? loginShell(),
    },
    detached: true, // its own process group, so a timeout kills the tree
    stdio: [request.stdin == null ? "ignore" : "pipe", "pipe", "pipe", "pipe"],
  });
  const release = child.stdio[3] as Writable;
  release.on("error", () => {});
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });

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
      if (!broken[name] && written[name] < fileCap) {
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

  let timedOut = false;
  let cancelled = false;
  const stop = () => {
    if (child.pid != null)
      killGroup(
        child.pid,
        grace,
        () => child.exitCode != null || child.signalCode != null,
      );
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

  const finish = async () => {
    const result = await exited.finally(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    });
    await Promise.all(
      Object.values(files).map(
        (f) => new Promise<void>((done) => f.end(() => done())),
      ),
    );
    return result;
  };

  // Record the process before releasing it. If that fails, it is never
  // released: closing fd 3 ends the wrapper before the command runs.
  try {
    if (child.pid == null) throw new Error("the command could not be started");
    opts.onSpawn?.(child);
  } catch (err) {
    release.destroy();
    await finish().catch(() => {});
    throw new ExecNotStarted(
      `the command was not started: ${(err as Error).message}`,
    );
  }
  release.end("go\n");
  if (request.stdin != null) {
    child.stdin!.on("error", () => {}); // the command may not read it
    child.stdin!.end(Buffer.from(request.stdin, "base64"));
  }
  if (opts.signal?.aborted) onAbort();

  const { code, signal } = await finish();
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
