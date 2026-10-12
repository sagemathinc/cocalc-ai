/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Starting a command so that a crash at any point is safe, and so that the
// process group we may later signal is provably ours.
//
// - Release handshake: every command runs under a small /bin/sh wrapper that
//   first waits on fd 3. The daemon writes "go" there only after it has
//   durably recorded the wrapper's pid and start time. If the daemon dies
//   (or can't record) first, fd 3 closes and the wrapper exits without
//   running anything.
// - A stable group leader: the wrapper leads the command's process group,
//   ignores SIGTERM once the command is running, and (on Linux) stays alive
//   until nothing else is left in the group. The daemon signals a group only
//   while its leader is alive and verified by pid and start time; a bare
//   group id is never trusted (a dead group's id can be reused).
// - On macOS there is no /proc to scan, so the wrapper leaves when the
//   command does; descendants it leaves behind in the group are not
//   signalled afterwards (direct mode is best effort there).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Wait for the daemon's release on fd 3; exit without running otherwise. */
export const RELEASE_PRELUDE = `
IFS= read -r go <&3 || exit 125
exec 3<&-
[ "$go" = go ] || exit 125
`;

/**
 * Stay the group's leader while any other process is in the group (Linux).
 * Only shell builtins run during a scan, so the scan itself adds no member.
 */
export const STAY_LEADER = `
if [ -r /proc/self/stat ]; then
  while :; do
    others=
    for d in /proc/[0-9]*; do
      [ "$d" = "/proc/$$" ] && continue
      line=
      read -r line 2>/dev/null < "$d/stat" || continue
      rest=\${line##*) }
      set -- $rest
      if [ "$3" = "$$" ]; then others=1; break; fi
    done
    [ -z "$others" ] && break
    sleep 1
  done
fi
`;

/** The start time of a process, or undefined if it isn't running. */
export function processStartTime(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err?.code !== "EPERM") return undefined;
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime), counted after the parenthesized command name.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19];
    } catch {
      return undefined;
    }
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", `${pid}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** Is the recorded group leader still that same process? */
export function leaderAlive(
  pid: number | null,
  pid_start: string | null,
): boolean {
  if (pid == null) return false;
  const start = processStartTime(pid);
  if (start == null) return false;
  // Without a recorded start time we can't tell a reused pid apart.
  if (pid_start == null || start !== pid_start) return false;
  return durableIdentity || spawnedHere.get(pid) === pid_start;
}

/**
 * Is a recorded start time a strong identity across daemon restarts? On
 * Linux it is (/proc starttime, in clock ticks since boot). On macOS `ps -o
 * lstart` has one-second resolution, so a reused pid could match; there a
 * persisted identity is trusted only by the daemon process that spawned it,
 * and processes left by a previous daemon are not signalled (best effort,
 * documented).
 */
let durableIdentity = process.platform === "linux";
const spawnedHere = new Map<number, string>();

/** Tests only: pretend the platform's identity is (not) durable. */
export function setDurableIdentityForTesting(value: boolean | null): void {
  durableIdentity = value ?? process.platform === "linux";
}

/** Signal a process group, only while its verified leader is alive. */
export function signalVerifiedGroup(
  pid: number | null,
  pid_start: string | null,
  signal: NodeJS.Signals,
): boolean {
  if (!leaderAlive(pid, pid_start)) return false;
  try {
    process.kill(-pid!, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * A process's identity, read right after spawning it, before it is released.
 * Retried briefly (reading /proc or ps can fail transiently); if it still
 * can't be read, this throws and the caller must not release the process:
 * a command whose identity we don't know could never be stopped later.
 */
export function captureIdentity(
  pid: number,
  identify: (pid: number) => string | undefined = processStartTime,
  attempts = 10,
  delayMs = 20,
): string {
  for (let i = 0; i < attempts; i++) {
    const start = identify(pid);
    if (start) {
      spawnedHere.set(pid, start);
      return start;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  throw new Error(`could not identify process ${pid}`);
}
