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
//   group id is never trusted (a dead group's id can be reused). On Linux
//   the identity includes the boot id, so no record from an earlier boot
//   (or one written before boot ids were recorded) can match.
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

/**
 * A process's identity, or undefined if it isn't running. On Linux this is
 * the boot id and the /proc start time (ticks since that boot), so a record
 * from an earlier boot never matches a process of this one. On macOS it is
 * `ps -o lstart` (one-second resolution; see leaderAlive).
 */
export function processStartTime(pid: number): string | undefined {
  if (identifyOverride != null) return identifyOverride(pid);
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    if (err?.code !== "EPERM") return undefined;
  }
  if (process.platform === "linux") {
    const boot = linuxBootId();
    if (boot == null) return undefined;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      // Field 22 (starttime), counted after the parenthesized command name.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `${boot}:${fields[19]}` : undefined;
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

let bootIdCache: string | null | undefined;
let bootIdOverride: string | null | undefined;

function linuxBootId(): string | undefined {
  if (bootIdOverride !== undefined) return bootIdOverride ?? undefined;
  if (bootIdCache === undefined) {
    try {
      bootIdCache =
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      bootIdCache = null;
    }
  }
  return bootIdCache ?? undefined;
}

/**
 * Is the recorded group leader still that same process?
 *
 * On Linux the identity (boot id, start tick) is strong across daemon
 * restarts. On macOS it is not (a pid reused within the same second has the
 * same lstart), so there only a process this daemon spawned and has not yet
 * reaped counts: until Node reaps a child its pid can't be reused, so the
 * pid still names our process. Processes left by a previous daemon, or
 * already reaped, are never signalled there (best effort, documented).
 */
export function leaderAlive(
  pid: number | null,
  pid_start: string | null,
): boolean {
  if (pid == null) return false;
  const start = processStartTime(pid);
  if (start == null) return false;
  // Without a recorded identity we can't tell a reused pid apart.
  if (pid_start == null || start !== pid_start) return false;
  if (durableIdentity) return true;
  return spawnedHere.get(pid)?.start === pid_start;
}

let durableIdentity = process.platform === "linux";
/** Children this daemon spawned and Node has not reaped yet. */
const spawnedHere = new Map<number, { start: string }>();
let identifyOverride: ((pid: number) => string | undefined) | undefined;

/** Tests only: pretend the platform's identity is (not) durable. */
export function setDurableIdentityForTesting(value: boolean | null): void {
  durableIdentity = value ?? process.platform === "linux";
}

/** Tests only: pretend the current boot id is this (null: unreadable). */
export function setBootIdForTesting(value: string | null | undefined): void {
  bootIdOverride = value;
}

/** Tests only: what processStartTime reports (e.g. a reused pid). */
export function setIdentifyForTesting(
  fn: ((pid: number) => string | undefined) | undefined,
): void {
  identifyOverride = fn;
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

/** The part of a ChildProcess captureIdentity needs. */
export interface SpawnedChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "exit", listener: () => void): unknown;
}

/**
 * A spawned child's identity, read right after spawning it, before it is
 * released. Retried briefly (reading /proc or ps can fail transiently); if it
 * still can't be read, this throws and the caller must not release the
 * process: a command whose identity we don't know could never be stopped.
 */
export function captureIdentity(
  child: SpawnedChild,
  identify: (pid: number) => string | undefined = processStartTime,
  attempts = 10,
  delayMs = 20,
): string {
  const pid = child.pid;
  if (pid == null) throw new Error("the process has no pid");
  for (let i = 0; i < attempts; i++) {
    if (child.exitCode != null || child.signalCode != null) break;
    const start = identify(pid);
    if (start) {
      const entry = { start };
      spawnedHere.set(pid, entry);
      // Once reaped, the pid may belong to anyone.
      child.once("exit", () => {
        if (spawnedHere.get(pid) === entry) spawnedHere.delete(pid);
      });
      return start;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
  throw new Error(`could not identify process ${pid}`);
}
