/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { constants } from "node:fs";
import type { Dir, Dirent, Stats } from "node:fs";
import { lstat, open, opendir, readFile, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { posix } from "node:path";

export interface SandboxedDirectoryStream {
  read(): Promise<Dirent | null>;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}

function failure(code: string): NodeJS.ErrnoException {
  return Object.assign(Error(`directory census ${code}`), { code });
}
function same(a: Stats, b: Stats) {
  return a.dev === b.dev && a.ino === b.ino && b.isDirectory();
}
function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure("ETIMEDOUT")), ms);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
async function mountId(handle: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1];
  if (!id) throw failure("EOPNOTSUPP");
  return id;
}

// Timed-out kernel work retains its admission slot until its eventual cleanup.
// Retrying cannot grow an unbounded collection of hung reads/file descriptors.
let admitted = 0;
const MAX_STREAMS = 32;

/**
 * Local-only Linux primitive. Root is the trusted existing sandbox home mount.
 * No content reads, subprocesses, traversal through links, or cross-mount walks.
 * Other platforms fail explicitly rather than weaken descriptor validation.
 */
export async function openSandboxDirectoryStream(
  root: string,
  path: string,
  timeoutMs = 5000,
): Promise<SandboxedDirectoryStream> {
  if (process.platform !== "linux") throw failure("EOPNOTSUPP");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000)
    throw failure("EINVAL");
  if (
    !posix.isAbsolute(root) ||
    !posix.isAbsolute(path) ||
    posix.normalize(root) !== root ||
    posix.normalize(path) !== path ||
    Buffer.byteLength(path) > 4096
  )
    throw failure("EINVAL");
  const relative = posix.relative(root, path);
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    posix.isAbsolute(relative)
  )
    throw failure("EXDEV");
  if (admitted >= MAX_STREAMS) throw failure("EBUSY");
  admitted++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      admitted--;
    }
  };
  let rootHandle: FileHandle | undefined;
  let current: FileHandle | undefined;
  let directory: Dir | undefined;
  let pending: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    cleanup ??= (async () => {
      try {
        await pending?.catch(() => {});
        try {
          await directory?.close();
        } finally {
          try {
            if (current && current !== rootHandle) await current.close();
          } finally {
            await rootHandle?.close();
          }
        }
      } finally {
        release();
      }
    })();
    return deadline(cleanup, timeoutMs);
  };
  const opening = (async (): Promise<SandboxedDirectoryStream> => {
    try {
      const flags =
        constants.O_RDONLY |
        constants.O_DIRECTORY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK;
      rootHandle = await open(root, flags);
      current = rootHandle;
      const rootStat = await rootHandle.stat();
      const rootMount = await mountId(rootHandle);
      const rootReal = await realpath(`/proc/self/fd/${rootHandle.fd}`);
      for (const component of relative ? relative.split("/") : []) {
        const parent = current;
        const child = await open(
          `/proc/self/fd/${parent.fd}/${component}`,
          flags,
        );
        current = child;
        try {
          if (
            (await mountId(child)) !== rootMount ||
            (await child.stat()).dev !== rootStat.dev
          )
            throw failure("EXDEV");
        } finally {
          if (parent !== rootHandle) await parent.close();
        }
      }
      const expected = posix.join(rootReal, relative);
      const initial = await current.stat();
      const verify = async () => {
        if (closed) throw failure("EBADF");
        const rootNow = await lstat(root);
        const actual = await realpath(`/proc/self/fd/${current!.fd}`);
        const currentStat = await current!.stat();
        if (
          !same(rootStat, rootNow) ||
          actual !== expected ||
          currentStat.mtimeMs !== initial.mtimeMs ||
          currentStat.ctimeMs !== initial.ctimeMs ||
          (await mountId(current!)) !== rootMount
        )
          throw failure("ESTALE");
      };
      await verify();
      directory = await opendir(`/proc/self/fd/${current.fd}`, {
        bufferSize: 1,
      });
      const operate = async <T>(run: () => Promise<T>): Promise<T> => {
        if (closed) throw failure("EBADF");
        if (pending) throw failure("EBUSY");
        const work = run();
        pending = work;
        try {
          return await deadline(work, timeoutMs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT")
            void close().catch(() => {});
          throw error;
        } finally {
          void work
            .finally(() => {
              if (pending === work) pending = undefined;
            })
            .catch(() => {});
        }
      };
      return {
        read: () =>
          operate(async () => {
            await verify();
            const entry = await directory!.read();
            await verify();
            return entry;
          }),
        assertCurrent: () => operate(verify),
        close,
      };
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  })();
  try {
    return await deadline(opening, timeoutMs);
  } catch (error) {
    // A late open is never handed to the caller after its admission timed out.
    void opening
      .then(
        (stream) => stream.close(),
        () => {},
      )
      .catch(() => {});
    throw error;
  }
}
