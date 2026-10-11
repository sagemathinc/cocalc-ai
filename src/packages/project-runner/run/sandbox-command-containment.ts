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
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SCOPE = new RegExp(`^job-(\\d+)-(\\d+)-(\\d+)-(\\d+)-(\\d+)-(${UUID})$`);
// Fixed admission refusals from the helper; its free-form diagnostics stay private.
const REJECTION_REASONS = new Map([
  ["host-busy", "the project host was busy with maintenance"],
  ["project-not-running", "the project is not running or is restarting"],
  ["project-restarted", "the project restarted"],
  ["invalid-request", "the request was invalid"],
  ["admission-failed", "the project host could not admit it"],
  ["cancelled", "it was cancelled while waiting for the project host"],
]);

function notStartedMessage(reason?: string): string {
  const why =
    REJECTION_REASONS.get(reason ?? "") ?? "the project host refused it";
  return `Project command was not started because ${why}. Nothing ran; try again.`;
}
type Recovery = { project_id: string; scope: string; confirmed: () => void };
const recoveries = new Map<string, Recovery>();
let recoveryTimer: ReturnType<typeof setInterval> | undefined;
let recovering = false;

// Rootless Podman moves itself into a new systemd scope of the user's session
// when it does not own its cgroup. Where the user's systemd can do that (e.g.
// CoCalc Star in Docker), the command would leave its job scope and fail the
// containment check. Without a reachable user bus Podman stays put; it needs
// no bus otherwise, since it uses the cgroupfs manager.
export function containedPodmanEnv(): NodeJS.ProcessEnv {
  return {
    ...podmanEnv(),
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/dev/null/cocalc-no-user-bus",
  };
}

function retainRecovery(recovery: Recovery) {
  recoveries.set(recovery.scope, recovery);
  if (recoveryTimer) return;
  // This runs in the execution worker, not just the main host's orphan reaper.
  // It outlives controllers and never retains scripts, credentials or output.
  recoveryTimer = setInterval(() => void recover(), 30_000);
  recoveryTimer.unref();
  // Most leftovers exit within seconds of being killed: check once soon, so a
  // fenced agent session reopens quickly instead of after a full interval.
  setTimeout(() => void recover(), 5_000).unref();
}

async function recover(): Promise<void> {
  if (recovering || recoveries.size === 0) return;
  recovering = true;
  const batch = [...recoveries.values()].slice(0, 64);
  // Rotate unresolved entries so a busy scope cannot starve later recoveries.
  for (const entry of batch) {
    recoveries.delete(entry.scope);
    recoveries.set(entry.scope, entry);
  }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        "sudo",
        ["-n", HELPER, "confirm-project-job-cleanup"],
        { cwd: "/", timeout: 30_000, maxBuffer: 65536 },
        (error, stdout) =>
          error
            ? reject(Error("Cleanup confirmation unavailable"))
            : resolve(stdout),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(
        JSON.stringify({
          jobs: batch.map(({ project_id, scope }) => ({ project_id, scope })),
        }) + "\n",
      );
    });
    const result = JSON.parse(stdout);
    if (
      !Array.isArray(result?.confirmed) ||
      result.confirmed.length > batch.length
    )
      throw Error("Invalid cleanup confirmation");
    const confirmed = new Set<Recovery>();
    for (const proof of result.confirmed) {
      const entry = batch.find(
        (entry) =>
          entry.project_id === proof?.project_id &&
          entry.scope === proof?.scope,
      );
      if (!entry) throw Error("Unknown cleanup confirmation");
      confirmed.add(entry);
    }
    for (const entry of confirmed) {
      recoveries.delete(entry.scope);
      entry.confirmed();
    }
  } catch {
    // Missing/old helpers, transport errors and malformed replies prove nothing.
  } finally {
    recovering = false;
    if (!recoveries.size) {
      clearInterval(recoveryTimer);
      recoveryTimer = undefined;
    }
  }
}

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
  onCleanupConfirmed,
}: {
  project_id: string;
  args: string[];
  signal: AbortSignal;
  timeoutMs: number;
  onOutput: (stream: "stdout" | "stderr", data: string) => void;
  onCleanupConfirmed?: () => void;
}): Promise<SandboxExecResult> {
  if (signal.aborted)
    return Promise.resolve({
      stdout: "",
      stderr: "",
      code: 130,
      cleanupConfirmed: true,
    });
  return new Promise((resolve) => {
    const jobId = randomUUID();
    const child = spawn(
      "sudo",
      [
        "-n",
        HELPER,
        "supervise-project-job",
        project_id,
        jobId,
        String(process.pid),
        String(timeoutMs),
      ],
      { cwd: "/", stdio: "pipe" },
    );
    let stopping = false;
    let invalid = false;
    let proof: { code: number } | undefined;
    let scope: string | undefined;
    // The helper publishes the scope before it launches anything, so a helper
    // that exits on its own without one never started the command.
    let framed = false;
    let rejected: string | undefined;
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
    child.stdin.write(
      JSON.stringify({ args, env: containedPodmanEnv() }) + "\n",
    );
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
          if (rejected !== undefined) throw Error("Data after rejection");
          if (
            frame.type === "rejected" &&
            !framed &&
            typeof frame.reason === "string" &&
            REJECTION_REASONS.has(frame.reason)
          ) {
            rejected = frame.reason;
          } else if (
            frame.type === "scope" &&
            typeof frame.scope === "string"
          ) {
            if (frame.scope.length > 256) throw Error("Oversized job scope");
            const match = SCOPE.exec(frame.scope);
            if (
              scope ||
              !match ||
              match[1] !== String(process.pid) ||
              match[6] !== jobId
            )
              throw Error("Invalid job scope");
            scope = frame.scope;
          } else if (
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
          framed = true;
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
    child.once("close", (code: number | null) => {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      clearTimeout(force);
      signal.removeEventListener("abort", stop);
      // Not started: the helper refused admission, or exited by itself (not
      // killed by the fallback above) before publishing a scope. Without a
      // scope there was no execution authority, so nothing needs recovery.
      // An old helper reports a busy lifecycle lock this way, with no frame.
      if (
        !invalid &&
        buffer.length === 0 &&
        scope === undefined &&
        proof === undefined &&
        (rejected !== undefined || (!framed && code !== null && code !== 0))
      ) {
        onCleanupConfirmed?.();
        resolve({
          stdout: "",
          stderr: notStartedMessage(rejected),
          code: null,
          cleanupConfirmed: true,
        });
        return;
      }
      const confirmed = proof !== undefined && !invalid && buffer.length === 0;
      if (onCleanupConfirmed) {
        if (confirmed) onCleanupConfirmed();
        else if (scope)
          retainRecovery({ project_id, scope, confirmed: onCleanupConfirmed });
      }
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
