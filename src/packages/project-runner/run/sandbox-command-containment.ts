/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { podmanEnv } from "@cocalc/backend/podman/env";
import type { SandboxExecResult } from "./sandbox-exec";

const HELPER = "/usr/local/sbin/cocalc-runtime-storage";

export function reapManagedSandboxCommands(): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "sudo",
      ["-n", HELPER, "reap-project-jobs"],
      { cwd: "/", timeout: 30_000, maxBuffer: 65536 },
      (error) =>
        error
          ? reject(Error("Managed project job reconciliation failed"))
          : resolve(),
    );
  });
}

/** Only the root-owned supervisor, never project stdout, can attest cleanup. */
export function runContainedSandboxCommand({
  project_id,
  args,
  signal,
  timeoutMs,
  onOutput,
}: {
  project_id: string;
  args: string[];
  signal: AbortSignal;
  timeoutMs: number;
  onOutput: (stream: "stdout" | "stderr", data: string) => void;
}): Promise<SandboxExecResult> {
  if (signal.aborted)
    return Promise.resolve({
      stdout: "",
      stderr: "",
      code: 130,
      cleanupConfirmed: true,
    });
  return new Promise((resolve) => {
    const child = spawn(
      "sudo",
      [
        "-n",
        HELPER,
        "supervise-project-job",
        project_id,
        randomUUID(),
        String(process.pid),
        String(timeoutMs),
      ],
      { cwd: "/", stdio: "pipe" },
    );
    let stopping = false;
    let invalid = false;
    let proof: { code: number } | undefined;
    let buffer = "";
    let force: ReturnType<typeof setTimeout> | undefined;
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.stdin.end();
      // A stuck transport is not proof of cleanup. If this fallback fires,
      // preserve the unresolved status and leave the scope to the orphan reaper.
      force = setTimeout(() => child.kill("SIGKILL"), 20_000);
    };
    child.stdin.on("error", stop);
    child.stdin.write(JSON.stringify({ args, env: podmanEnv() }) + "\n");
    const heartbeat = setInterval(() => {
      if (!stopping && !child.stdin.destroyed && !child.stdin.writableEnded)
        child.stdin.write(".\n");
    }, 1000);
    const deadline = setTimeout(stop, timeoutMs);
    child.stderr.resume(); // Never forward privileged helper diagnostics/secrets.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      if (invalid) return;
      try {
        buffer += data;
        if (buffer.length > 512 * 1024) throw Error("Oversized helper frame");
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const frame = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (proof) throw Error("Data after cleanup proof");
          if (
            frame.type === "output" &&
            (frame.stream === "stdout" || frame.stream === "stderr") &&
            typeof frame.data === "string" &&
            frame.data.length <= 8192
          ) {
            const stream = frame.stream as "stdout" | "stderr";
            onOutput(
              stream,
              decoders[stream].write(Buffer.from(frame.data, "base64")),
            );
          } else if (
            frame.type === "exit" &&
            frame.cleanup === true &&
            Number.isSafeInteger(frame.code)
          ) {
            for (const stream of ["stdout", "stderr"] as const) {
              const tail = decoders[stream].end();
              if (tail) onOutput(stream, tail);
            }
            proof = { code: frame.code };
          } else throw Error("Invalid helper frame");
        }
      } catch {
        invalid = true;
        stop();
      }
    });
    child.on("error", () => {
      invalid = true;
    });
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    child.once("close", () => {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      const confirmed = proof !== undefined && !invalid && buffer.length === 0;
      resolve({
        stdout: "",
        stderr: confirmed
          ? ""
          : "Project job cleanup is unconfirmed; execution is blocked pending runtime recovery",
        code: confirmed ? proof!.code : null,
        cleanupConfirmed: confirmed,
      });
    });
  });
}
