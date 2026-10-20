/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The exclusive lock of the process that serves persist-board-write (board
stream design A2b, section 5a; @cocalc/conat/persist/board-write-fence.ts).

A board write's instance nonce proves that the process which could have
accepted it is gone only if no two processes ever serve board writes at
once. So the process takes an exclusive kernel lock on one host-local lock
file before it chooses its nonce, and holds it for its whole life:

- Node has no flock(2), so, as project-host/upgrade.ts does, the file is
  opened and kept open here, and `flock -x` is run on that descriptor. The
  lock belongs to the open file description, so it outlives flock's own
  exit and is held until this process closes the descriptor or exits (the
  kernel releases it then, even after SIGKILL). Node opens files
  close-on-exec, so no other child inherits it.
- A second process blocks in flock until the first has exited.
- The lock proves anything only if every writer opens the SAME inode, on a
  filesystem whose flock is reliable. So before the nonce is chosen:
  - the filesystem must be a host-local one (ext4, xfs, btrfs, tmpfs);
  - the file's (dev, inode) must be the one the project host recorded when
    it created the file (ensureBoardWriteLockFile), when it gave one.
  Otherwise this fails, and the caller serves no board writes (fail closed).
- The file is created once (no truncation) and never unlinked or replaced.
  Nothing here or elsewhere removes it. assertWritable() also checks, before
  every board write, that the path still names the inode this process
  holds, so a replacement after startup is detected and stops board writes.
*/

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { join as joinPath } from "node:path";
import type { BoardWriteFence } from "@cocalc/conat/persist/board-write-fence";

// statfs(2) f_type values of the filesystems a lock may be on.
const LOCAL_FILESYSTEMS = new Map<number, string>([
  [0xef53, "ext4"],
  [0x58465342, "xfs"],
  [0x9123683e, "btrfs"],
  [0x01021994, "tmpfs"],
]);

export interface LockFileId {
  dev: number;
  ino: number;
}

export function formatLockFileId({ dev, ino }: LockFileId): string {
  return `${dev}:${ino}`;
}

export function parseLockFileId(
  value: string | undefined,
): LockFileId | undefined {
  const m = /^(\d+):(\d+)$/.exec(value ?? "");
  if (m == null) return undefined;
  const dev = Number(m[1]);
  const ino = Number(m[2]);
  if (!Number.isSafeInteger(dev) || !Number.isSafeInteger(ino)) return;
  return { dev, ino };
}

// Create the lock file if it doesn't exist (never truncating or replacing
// it), and return its identity. The project host calls this once at startup
// and gives the result to every process that may serve board writes.
export function ensureBoardWriteLockFile(path: string): LockFileId {
  const fd = fs.openSync(path, "a", 0o600);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Error(`${path} is not a regular file`);
    return { dev: st.dev, ino: st.ino };
  } finally {
    fs.closeSync(fd);
  }
}

export interface BoardWriteLock extends BoardWriteFence {
  readonly id: LockFileId;
  readonly filesystem: string;
  // Release the lock (closing the descriptor). After this, assertWritable
  // throws. Production shutdown never calls it: only the process's exit
  // releases the lock, so no successor can take it while a request of this
  // process could still store. Tests and failed checks use it.
  close(): void;
}

export async function acquireBoardWriteLock({
  path,
  expected,
  waitSeconds,
  filesystemType,
}: {
  path: string;
  // The identity the project host recorded; checked when given.
  expected?: LockFileId;
  // Give up after this long instead of waiting for the holder to exit.
  waitSeconds?: number;
  // For tests: the statfs type to assume.
  filesystemType?: number;
}): Promise<BoardWriteLock> {
  // "a": create if missing, never truncate; close-on-exec, as Node opens all
  // files.
  const fd = fs.openSync(path, "a", 0o600);
  let ok = false;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw Error(`${path} is not a regular file`);
    const id = { dev: st.dev, ino: st.ino };
    if (
      expected != null &&
      (expected.dev !== id.dev || expected.ino !== id.ino)
    ) {
      throw Error(
        `${path} is not the lock file the project host created (${formatLockFileId(id)}, expected ${formatLockFileId(expected)})`,
      );
    }
    const type = filesystemType ?? fs.statfsSync(path).type;
    const filesystem = LOCAL_FILESYSTEMS.get(type);
    if (filesystem == null) {
      throw Error(
        `${path} is on a filesystem (type 0x${type.toString(16)}) where its lock can't be trusted`,
      );
    }
    await flockExclusive(fd, waitSeconds);
    // Only after the lock: this process's identity.
    const nonce = randomBytes(16).toString("hex");
    let closed = false;
    const lock: BoardWriteLock = {
      nonce,
      id,
      filesystem,
      assertWritable() {
        if (closed) throw Error("the board write lock was released");
        const now = fs.statSync(path, { throwIfNoEntry: false });
        if (now == null)
          throw Error(`the board write lock ${path} was removed`);
        if (now.dev !== id.dev || now.ino !== id.ino) {
          throw Error(`the board write lock ${path} was replaced`);
        }
      },
      close() {
        if (closed) return;
        closed = true;
        fs.closeSync(fd);
      },
    };
    ok = true;
    return lock;
  } finally {
    if (!ok) fs.closeSync(fd);
  }
}

// flock -x on our descriptor, passed to the child as its fd 3.
function flockExclusive(fd: number, waitSeconds?: number): Promise<void> {
  const args = ["-x"];
  if (waitSeconds != null) args.push("-w", `${waitSeconds}`);
  args.push("3");
  return new Promise<void>((resolve, reject) => {
    const child = spawn("flock", args, {
      stdio: ["ignore", "ignore", "ignore", fd],
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            Error(
              `the board write lock is held by another process (flock exit ${code})`,
            ),
          ),
    );
  });
}

export const BOARD_WRITE_LOCK_ENV = "COCALC_PROJECT_HOST_BOARD_WRITE_LOCK";
export const BOARD_WRITE_LOCK_ID_ENV =
  "COCALC_PROJECT_HOST_BOARD_WRITE_LOCK_ID";

// The lock file: set by the project host's daemon for every process it
// starts, else beside the host's data.
export function boardWriteLockPath(dataDir: string): string {
  return (
    process.env[BOARD_WRITE_LOCK_ENV] || joinPath(dataDir, "board-write.lock")
  );
}

export type BoardWriteFenceStatus =
  | { ok: true; nonce: string; filesystem: string }
  | {
      ok: false;
      reason: "board-lock-waiting" | "board-lock-invalid";
      message: string;
    };

export interface BoardWriteFenceController {
  // For persist/server.ts: the fence now, or undefined (writes refused).
  fence: () => BoardWriteFence | undefined;
  status(): BoardWriteFenceStatus;
  close(): void;
}

/*
Take the board write lock in the background, so that startup never blocks
on it. Until it is held, and for good after the lock file's invariant is
found broken, board writes are refused (fail closed) and status() says why.
Only "another process holds it" is retried.
*/
export function startBoardWriteFence({
  path,
  expected = parseLockFileId(process.env[BOARD_WRITE_LOCK_ID_ENV]),
  recheckMs = 10_000,
  retryMs = 5_000,
  log = () => {},
  acquire = acquireBoardWriteLock,
}: {
  path: string;
  expected?: LockFileId;
  recheckMs?: number;
  retryMs?: number;
  log?: (message: string, extra?: object) => void;
  acquire?: typeof acquireBoardWriteLock;
}): BoardWriteFenceController {
  let lock: BoardWriteLock | undefined;
  let closed = false;
  let status: BoardWriteFenceStatus = {
    ok: false,
    reason: "board-lock-waiting",
    message: "taking the board write lock",
  };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const invalid = (message: string) => {
    status = { ok: false, reason: "board-lock-invalid", message };
    log("board write lock invalid: board writes are refused", {
      path,
      message,
    });
    lock?.close();
    lock = undefined;
  };

  const recheck = () => {
    timer = undefined;
    if (closed || lock == null) return;
    try {
      lock.assertWritable();
      timer = setTimeout(recheck, recheckMs);
      (timer as any).unref?.();
    } catch (err) {
      invalid(`${err}`);
    }
  };

  const attempt = async () => {
    timer = undefined;
    if (closed) return;
    try {
      const got = await acquire({ path, expected, waitSeconds: 30 });
      if (closed) {
        got.close();
        return;
      }
      lock = got;
      status = { ok: true, nonce: got.nonce, filesystem: got.filesystem };
      log("board write lock held", { path, filesystem: got.filesystem });
      timer = setTimeout(recheck, recheckMs);
      (timer as any).unref?.();
    } catch (err) {
      const message = `${err}`;
      if (/held by another process/.test(message)) {
        status = { ok: false, reason: "board-lock-waiting", message };
        timer = setTimeout(attempt, retryMs);
        (timer as any).unref?.();
      } else {
        invalid(message);
      }
    }
  };
  void attempt();

  return {
    fence: () => {
      if (lock == null) return undefined;
      return lock;
    },
    status: () => status,
    close: () => {
      closed = true;
      if (timer != null) clearTimeout(timer);
      lock?.close();
      lock = undefined;
    },
  };
}
