/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host-side reads and writes of files inside a project's home.

The home belongs to the project user, who can replace any directory in it with
a symlink, for example to the host service account's ~/.ssh. Path-based fs
calls from the host would follow it and act on host files. These helpers go
through an openat2 SandboxRoot anchored at the home, which resolves every path
beneath it and refuses symlinks (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS), so a
planted link fails instead of redirecting the operation. Only the final file
may be a symlink: a write replaces the link itself, and a read treats it as
absent.
*/

import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { SandboxRoot } from "@cocalc/openat2";

function errorCode(err: unknown): string | undefined {
  return `${(err as Error)?.message ?? ""}`.match(/^(E[A-Z]+)\b/)?.[1];
}

// Whether `path` exists (as anything, a symlink included) under `home`.
// A symlinked parent directory throws.
export function existsBeneathHome(home: string, path: string): boolean {
  const root = new SandboxRoot(home);
  const dir = dirname(path);
  if (dir !== ".") {
    try {
      root.stat(dir);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return false;
      throw err;
    }
  }
  try {
    root.stat(path);
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT") return false;
    if (code === "ELOOP") return true;
    throw err;
  }
}

// Reads a regular file under `home`; undefined if it is missing or is itself a
// symlink. A symlinked parent directory throws.
export function readFileBeneathHome(
  home: string,
  path: string,
  maxBytes = 1 << 20,
): string | undefined {
  if (!existsBeneathHome(home, path)) return undefined;
  const root = new SandboxRoot(home);
  let fd: number;
  try {
    fd = root.openRead(path);
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ELOOP") return undefined;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (n === 0) break;
      size += n;
    }
    if (size > maxBytes) {
      throw new Error(`${path} is larger than ${maxBytes} bytes`);
    }
    return buffer.subarray(0, size).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

// Atomically writes `content` to `path` under `home` (tmp file + rename),
// creating missing parent directories with `dirMode` (and setting it on the
// parent unless `chmodDir` is false). With `noReplace`, an existing entry is
// kept and false is returned.
export function writeFileBeneathHome(
  home: string,
  path: string,
  content: string,
  {
    mode = 0o600,
    dirMode = 0o700,
    noReplace = false,
    chmodDir = true,
  }: {
    mode?: number;
    dirMode?: number;
    noReplace?: boolean;
    chmodDir?: boolean;
  } = {},
): boolean {
  const root = new SandboxRoot(home);
  const dir = dirname(path);
  if (dir !== ".") {
    root.mkdir(dir, true, dirMode);
    if (chmodDir) root.chmod(dir, dirMode);
  }
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    const fd = root.openWrite(tmpPath, true, true, false, mode);
    try {
      const data = Buffer.from(content);
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
    } finally {
      closeSync(fd);
    }
    root.chmod(tmpPath, mode);
    if (noReplace) {
      try {
        root.renameNoReplace(tmpPath, path);
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
        root.unlink(tmpPath);
        return false;
      }
    } else {
      root.rename(tmpPath, path);
    }
    return true;
  } catch (err) {
    try {
      root.unlink(tmpPath);
    } catch {}
    throw err;
  }
}

// Creates directory `path` (and missing parents) under `home`.
export function mkdirBeneathHome(
  home: string,
  path: string,
  mode = 0o700,
): void {
  new SandboxRoot(home).mkdir(path, true, mode);
}

// Removes `path` under `home` recursively, if present. A symlink at `path` is
// removed itself, links inside the tree are not followed, and a symlinked
// parent directory throws.
export async function rmBeneathHome(home: string, path: string): Promise<void> {
  try {
    await new SandboxRoot(home).rm(path, true, true);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") throw err;
  }
}

// Whether `err` is a refusal to follow a symlink.
export function isSymlinkRefusal(err: unknown): boolean {
  return errorCode(err) === "ELOOP";
}
