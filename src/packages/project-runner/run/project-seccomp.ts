/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Seccomp profile for project containers: the hosts' default profile with
// IPv4 IP options (setsockopt IP_OPTIONS/IP_RETOPTS), MPTCP sockets and the
// 32-bit socketcall multiplexer refused. seccomp/generate.py derives
// seccomp/cocalc-project-seccomp.json from seccomp/base-seccomp.json and
// documents the rules. Podman reads the profile from a file, so it is written
// once per content into a directory only this user can use, checked, and its
// path passed to `podman create`. A start fails if that can't be done.
//
// The file's exact bytes come from seccomp/profile-bytes.ts (base64, made by
// generate.py), never from parsing the JSON: JavaScript numbers are doubles,
// and the 64-bit masks in the rules would be rounded.

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROFILE_BASE64, PROFILE_SHA256 } from "./seccomp/profile-bytes";

export const PROJECT_SECCOMP_HOST_ROOT = join(tmpdir(), "cocalc-project-seccomp");

// The reviewed seccomp/cocalc-project-seccomp.json. A regenerated profile
// changes this by hand, so it can't ship without being looked at.
export const PROJECT_SECCOMP_PROFILE_SHA256 =
  "9e75b898fe261435521e9f844535232850526eea178f9d3dbbe66402a7437755";

const PROFILE_BYTES = Buffer.from(PROFILE_BASE64, "base64");

function checkProfileBytes(): void {
  const sha = createHash("sha256").update(PROFILE_BYTES).digest("hex");
  if (sha !== PROJECT_SECCOMP_PROFILE_SHA256 || sha !== PROFILE_SHA256) {
    throw Error(
      `project seccomp profile bytes have sha256 ${sha}, not the reviewed ${PROJECT_SECCOMP_PROFILE_SHA256}`,
    );
  }
}

function ownUid(): number {
  if (typeof process.getuid !== "function") {
    throw Error("project seccomp profile: no uid on this platform");
  }
  return process.getuid();
}

async function isProfile(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.uid !== ownUid() || (st.mode & 0o022) !== 0) {
      return false;
    }
    return (await readFile(path)).equals(PROFILE_BYTES);
  } catch {
    return false;
  }
}

export async function projectSeccompProfilePath(
  root: string = PROJECT_SECCOMP_HOST_ROOT,
): Promise<string> {
  checkProfileBytes();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const st = await lstat(root);
  if (!st.isDirectory() || st.uid !== ownUid()) {
    throw Error(`project seccomp directory ${root} is not this user's directory`);
  }
  await chmod(root, 0o700);
  const path = join(
    root,
    `cocalc-project-${PROJECT_SECCOMP_PROFILE_SHA256.slice(0, 16)}.json`,
  );
  if (await isProfile(path)) {
    return path;
  }
  const tmp = join(root, `.tmp-${process.pid}-${Date.now()}`);
  try {
    await writeFile(tmp, PROFILE_BYTES, { mode: 0o600, flag: "wx" });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  if (!(await isProfile(path))) {
    throw Error("project seccomp profile could not be verified after writing");
  }
  return path;
}
