/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { spawn } from "node:child_process";
import type { SandboxExecResult } from "./sandbox-exec";

/** Keep the existing in-container supervisor leased until the job, not an RPC, ends. */
export function runStreamingSandboxCommand({
  command,
  args,
  env,
  signal,
  timeoutMs,
  onOutput,
}: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  onOutput: (stream: "stdout" | "stderr", data: string) => void;
}): Promise<SandboxExecResult> {
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: "/", env, stdio: "pipe" });
    let stopping = false;
    let failed = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      // EOF/lease expiry kills the command in-container before its client is reaped.
      force = setTimeout(() => child.kill("SIGKILL"), 10_000);
    };
    const heartbeat = setInterval(() => {
      if (!stopping && !child.stdin.destroyed && !child.stdin.writableEnded)
        child.stdin.write(".\n");
    }, 1000);
    const deadline = setTimeout(stop, timeoutMs);
    child.stdin.on("error", stop);
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (data: string) => {
        try {
          onOutput(stream, data);
        } catch {
          failed = true;
          stop();
        }
      });
    }
    child.on("error", () => {
      failed = true;
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("close", (code, exitSignal) => {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      resolve({
        stdout: "",
        stderr: failed ? "Project command transport failed" : "",
        code: stopping ? 130 : code,
        ...(exitSignal ? { signal: exitSignal } : {}),
      });
    });
  });
}
