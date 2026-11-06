/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Handing a host directory to a sidecar that runs with a separate runtime uid
(R1 PR3a, plan §3).

Under the separate map the runtime user (this daemon) isn't mapped into the
container, so a directory it creates shows as nobody there. Such a directory
is created by the daemon, filled, and then given to the project user's inner
id with `podman unshare chown`, which only the runtime user's own user
namespace allows. Its rules:

- H1: every handed-over directory sits under a parent the daemon owns with
  mode 0700. The project user (also after an escape) can't traverse it, so
  can't rename or swap what it was given, nor plant anything beside it.
- H2: ownership changes name exact, recorded paths, one at a time: never
  recursive, never following a symlink, fixed argv, no shell.
- Reading back (only what a sidecar was meant to update, e.g. a refreshed
  token) goes through openReadBack: a reader run in the runtime user's
  namespace that opens the recorded directory, then the one file name in it,
  with O_NOFOLLOW, accepts a regular file only, and caps the size. Never a
  path the project could have redirected, never a tool from a rootfs.
- Cleanup removes the exact recorded path (rm doesn't follow symlinks) and
  proves it gone with lstat.
*/

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, chmod } from "node:fs/promises";
import { join } from "node:path";
import { podmanEnv } from "@cocalc/backend/podman/env";

// Runs a command inside the runtime user's own user namespace.
export type Unshare = (
  argv: string[],
  opts?: { timeoutMs?: number },
) => Promise<{ stdout: string }>;

export const podmanUnshare: Unshare = async (argv, opts = {}) =>
  await new Promise((resolve, reject) =>
    execFile(
      "podman",
      ["unshare", ...argv],
      {
        cwd: "/",
        timeout: opts.timeoutMs ?? 30_000,
        killSignal: "SIGKILL",
        env: podmanEnv(),
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout) => (err ? reject(err) : resolve({ stdout: `${stdout}` })),
    ),
  );

export interface Handoff {
  // the exact directory handed over (recorded at creation)
  dir: string;
  // exact entries created inside it, also handed over
  entries: string[];
}

/** H1: the daemon-owned 0700 parent of every handed-over directory. */
export async function handoffParent(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Checked before chmod, which would follow a symlink in its place.
  const before = await lstat(root);
  if (!before.isDirectory()) {
    throw new Error("the handoff parent is not a directory");
  }
  if (process.getuid && before.uid !== process.getuid()) {
    throw new Error("the handoff parent is not the daemon's own");
  }
  // mkdir doesn't change an existing directory's mode
  await chmod(root, 0o700);
  const st = await lstat(root);
  if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) {
    throw new Error("the handoff parent is not a 0700 directory");
  }
  return root;
}

/** A fresh directory under the parent, recorded exactly. */
export async function createHandoffDir(
  parent: string,
  prefix: string,
): Promise<Handoff> {
  if (!/^[a-z0-9-]{1,32}$/.test(prefix)) throw new Error("bad prefix");
  const dir = await mkdtemp(join(parent, `${prefix}-`));
  return { dir, entries: [] };
}

/** H2: chown exactly these recorded paths to the inner id. */
export async function handOver(
  handoff: Handoff,
  innerId: number,
  unshare: Unshare = podmanUnshare,
): Promise<void> {
  if (!Number.isSafeInteger(innerId) || innerId < 1) {
    throw new Error("bad inner id");
  }
  for (const path of [...handoff.entries, handoff.dir]) {
    await unshare([
      "chown",
      "--no-dereference",
      `${innerId}:${innerId}`,
      "--",
      path,
    ]);
  }
}

// The reader: run by the runtime user's node in its own user namespace. It
// opens the recorded directory, then the name inside it, never following a
// symlink, and prints the file as base64 if it's a regular file within cap.
export const READ_BACK_CODE = String.raw`"use strict";
const fs = require("node:fs");
const [dir, name, capText] = process.argv.slice(-3);
const cap = Number(capText);
if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name === "." || name === "..") {
  process.stdout.write(JSON.stringify({ error: "EINVAL" }));
  process.exit(0);
}
let dfd, fd;
try {
  dfd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  fd = fs.openSync("/proc/self/fd/" + dfd + "/" + name,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const st = fs.fstatSync(fd);
  if (!st.isFile()) throw Object.assign(new Error("not a file"), { code: "EFTYPE" });
  if (st.size > cap) throw Object.assign(new Error("too large"), { code: "EFBIG" });
  const buf = Buffer.alloc(st.size);
  let off = 0;
  while (off < st.size) {
    const n = fs.readSync(fd, buf, off, st.size - off, off);
    if (n === 0) break;
    off += n;
  }
  process.stdout.write(JSON.stringify({ data: buf.subarray(0, off).toString("base64") }));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err.code || "EIO").slice(0, 16) }));
}
`;

/**
 * Reads back one file the sidecar was meant to update, or undefined (with
 * the reason) when it isn't a regular file within the cap.
 */
export async function readBack(
  handoff: Handoff,
  name: string,
  maxBytes: number,
  unshare: Unshare = podmanUnshare,
): Promise<{ data?: Buffer; error?: string }> {
  const { stdout } = await unshare(
    [
      process.execPath,
      "-e",
      READ_BACK_CODE,
      "--",
      handoff.dir,
      name,
      `${maxBytes}`,
    ],
    { timeoutMs: 30_000 },
  );
  let out: unknown;
  try {
    out = JSON.parse(stdout);
  } catch {
    return { error: "malformed" };
  }
  if (out == null || typeof out !== "object") return { error: "malformed" };
  const o = out as { data?: unknown; error?: unknown };
  if (typeof o.error === "string") return { error: o.error };
  if (typeof o.data !== "string") return { error: "malformed" };
  const data = Buffer.from(o.data, "base64");
  if (data.length > maxBytes) return { error: "EFBIG" };
  return { data };
}

/** Removes exactly the recorded directory, and proves it gone. */
export async function cleanupHandoff(
  handoff: Handoff,
  unshare: Unshare = podmanUnshare,
): Promise<void> {
  await unshare(["rm", "-rf", "--one-file-system", "--", handoff.dir]);
  try {
    await lstat(handoff.dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  throw new Error("a handed-over directory is still there after cleanup");
}
