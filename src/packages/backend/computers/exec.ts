/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// `exec` on a computer: one command in the user's login shell, in its own
// process group (so a timeout or revocation kills the whole tree), stdin
// closed unless given, and at most 1 MB of output returned. Nothing is kept
// on disk. Design: src/.agents/computers-direct-host-2026-10-16.md.

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_EXEC_OUTPUT_BYTES,
  argvScript,
  type CommandSpec,
  type ExecRequest,
  type ExecResult,
} from "@cocalc/util/computers/operations";

export interface ExecOptions {
  /** Relative cwds start here (the user's home). */
  workdir: string;
  shell?: string;
  maxOutputBytes?: number;
  /** Grace between SIGTERM and SIGKILL. */
  killGraceMs?: number;
  /** Abort: stop the command (revoked, or the connector is stopping). */
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
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
 * The line the login shell runs (-lc) and the environment it needs. An argv
 * never goes through the login shell's own parser (fish reads backslashes in
 * single quotes differently): the shell runs a fixed line that reads the same
 * in sh, bash, zsh and fish, in which /bin/sh only sets the positional
 * parameters from the quoted argv (argvScript) and then runs "$@".
 */
export function loginShellCommand(spec: CommandSpec): {
  line: string;
  env: Record<string, string>;
} {
  if (spec.argv == null) return { line: spec.command ?? "", env: {} };
  return {
    line: `exec /bin/sh -c 'a=$COCALC_ARGV; unset COCALC_ARGV; eval "$a"; "$@"'`,
    env: { COCALC_ARGV: argvScript(spec.argv) },
  };
}

/** SIGTERM the process group, then SIGKILL after the grace period. */
function killGroup(pid: number, graceMs: number, gone: () => boolean): void {
  const send = (signal: NodeJS.Signals) => {
    if (gone()) return;
    try {
      process.kill(-pid, signal);
    } catch {}
  };
  send("SIGTERM");
  setTimeout(() => send("SIGKILL"), graceMs).unref();
}

export async function runExec(
  request: ExecRequest,
  opts: ExecOptions,
): Promise<ExecResult> {
  const cwd = resolveCwd(opts.workdir, request.cwd);
  const run = loginShellCommand(request);
  const started = Date.now();
  const child = spawn(opts.shell ?? loginShell(), ["-lc", run.line], {
    cwd,
    env: { ...(opts.env ?? process.env), ...run.env },
    detached: true, // its own process group, so stopping it kills the tree
    stdio: [request.stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    // "close": the command exited and its output pipes are drained.
    child.on("close", (code, signal) => resolveExit({ code, signal }));
  });

  const kept = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let budget = opts.maxOutputBytes ?? MAX_EXEC_OUTPUT_BYTES;
  let truncated = false;
  for (const name of ["stdout", "stderr"] as const) {
    child[name]!.on("data", (chunk: Buffer) => {
      // Past the budget the output is still read (so the command never
      // blocks on a full pipe) but dropped.
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
    if (child.pid != null) {
      killGroup(
        child.pid,
        opts.killGraceMs ?? 5000,
        () => child.exitCode != null || child.signalCode != null,
      );
    }
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
  if (request.stdin != null) {
    child.stdin!.on("error", () => {}); // the command may not read it
    child.stdin!.end(Buffer.from(request.stdin, "base64"));
  }
  try {
    const { code, signal } = await exited;
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
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
