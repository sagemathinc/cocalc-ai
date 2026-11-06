/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Host hardening checks for the separate runtime uid, reported in the
// heartbeat: which mode projects actually start in, and whether the daemon's
// state directory is still private after a separate start.

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { runtimeUidModeReport } from "./runtime-host";

const logger = getLogger("project-runner:runtime-hardening");

export function daemonStateDir(): string {
  return `${process.env.COCALC_DATA ?? process.env.DATA ?? "/mnt/cocalc/data"}`;
}

export interface PathStat {
  uid: number;
  mode: number;
  isDirectory: boolean;
}

// An open directory: stat and chmod act on this exact inode (no path is
// followed twice), so a swapped-in symlink can't redirect the repair.
export interface OpenDir {
  stat(): Promise<PathStat>;
  chmod(mode: number): Promise<void>;
  close(): Promise<void>;
}

export interface DaemonStateCheck {
  ok: boolean;
  checked_at: string;
  // what was wrong ("missing", "not a directory or a symlink",
  // "owner <uid>", "mode <octal>")
  problem?: string;
  // mode put back to 0700 (only for a directory the runtime user owns)
  restored?: boolean;
}

/**
 * The daemon's state directory must be a 0700 directory of the runtime user.
 * It's opened without following symlinks and as a directory; a wrong mode on
 * that exact inode is restored. Anything else is reported only (the daemon
 * can't fix an owner, and shouldn't guess).
 */
export async function checkDaemonState({
  path,
  runtimeUid,
  openDir,
  now = new Date(),
}: {
  path: string;
  runtimeUid: number;
  // opens path as a directory, refusing symlinks; undefined if it doesn't
  // exist; throws ENOTDIR/ELOOP for anything else
  openDir: (path: string) => Promise<OpenDir | undefined>;
  now?: Date;
}): Promise<DaemonStateCheck> {
  const checked_at = now.toISOString();
  let dir: OpenDir | undefined;
  try {
    dir = await openDir(path);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    return {
      ok: false,
      checked_at,
      problem:
        code === "ENOTDIR" || code === "ELOOP"
          ? "not a directory or a symlink"
          : `unreadable (${code ?? "error"})`,
    };
  }
  if (dir == null) return { ok: false, checked_at, problem: "missing" };
  try {
    const st = await dir.stat();
    if (!st.isDirectory) {
      return { ok: false, checked_at, problem: "not a directory or a symlink" };
    }
    if (st.uid !== runtimeUid) {
      return { ok: false, checked_at, problem: `owner ${st.uid}` };
    }
    const mode = st.mode & 0o7777;
    if (mode === 0o700) return { ok: true, checked_at };
    const problem = `mode ${mode.toString(8).padStart(4, "0")}`;
    let restored = false;
    try {
      await dir.chmod(0o700);
      restored = ((await dir.stat()).mode & 0o7777) === 0o700;
    } catch (err) {
      logger.error("restoring the daemon state directory's mode failed", {
        err: `${err}`,
      });
    }
    return { ok: false, checked_at, problem, restored };
  } finally {
    await dir.close().catch(() => {});
  }
}

async function openHostDir(path: string): Promise<OpenDir | undefined> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return undefined;
    throw err;
  }
  return {
    stat: async () => {
      const info = await handle.stat();
      return {
        uid: info.uid,
        mode: info.mode,
        isDirectory: info.isDirectory(),
      };
    },
    chmod: async (mode: number) => await handle.chmod(mode),
    close: async () => await handle.close(),
  };
}

let lastDaemonState: DaemonStateCheck | undefined;

export function lastDaemonStateCheck(): DaemonStateCheck | undefined {
  return lastDaemonState;
}

/** After each separate-mode start; never fails the start. */
export async function checkDaemonStateAfterSeparateStart(): Promise<void> {
  try {
    const result = await checkDaemonState({
      path: daemonStateDir(),
      runtimeUid: process.getuid?.() ?? -1,
      openDir: openHostDir,
    });
    lastDaemonState = result;
    if (!result.ok) {
      logger.error(
        "the daemon state directory is not private after a separate start",
        result,
      );
    }
  } catch (err) {
    logger.error("checking the daemon state directory failed", {
      err: `${err}`,
    });
  }
}

export interface RuntimeUidModeHeartbeat {
  // the mode the host is configured for
  configured: string;
  // the mode the last project start actually used; "undecided" until the
  // first start after the daemon started
  effective: "keep-id" | "separate" | "undecided";
  reason?: string;
  detail?: string;
  label: string;
  // heartbeat metadata is merged: a stale report (e.g. after a rollback to
  // a build without it) must be recognizable
  reported_at: string;
  daemon_state?: DaemonStateCheck;
}

export function configuredRuntimeUidMode(): string {
  return (
    `${process.env.COCALC_PROJECT_RUNTIME_UID_MODE ?? ""}`.trim() || "keep-id"
  );
}

export function runtimeUidModeHeartbeat(
  now = new Date(),
): RuntimeUidModeHeartbeat {
  const report = runtimeUidModeReport();
  const daemon_state = lastDaemonState;
  if (report == null) {
    return {
      configured: configuredRuntimeUidMode(),
      effective: "undecided",
      label: "undecided",
      reported_at: now.toISOString(),
      ...(daemon_state ? { daemon_state } : {}),
    };
  }
  return {
    configured: report.configured,
    effective: report.effective,
    ...(report.reason ? { reason: report.reason } : {}),
    ...(report.detail ? { detail: report.detail } : {}),
    label: report.label,
    reported_at: now.toISOString(),
    ...(daemon_state ? { daemon_state } : {}),
  };
}
