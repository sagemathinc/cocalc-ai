/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SandboxRoot } from "@cocalc/openat2";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";

function isMissing(err: unknown): boolean {
  return /^ENOENT\b/.test(`${(err as Error)?.message ?? ""}`);
}

function isSymlinkRefusal(err: unknown): boolean {
  return /^ELOOP\b/.test(`${(err as Error)?.message ?? ""}`);
}

// Writes the managed authorized_keys file in a project's home.
//
// The home belongs to the project user, who can replace any part of
// ~/.ssh/.cocalc with a symlink (for example to the host service account's
// ~/.ssh). Every step therefore goes through a descriptor anchored at the home
// that refuses symlinks and never leaves it (openat2 RESOLVE_BENEATH |
// RESOLVE_NO_SYMLINKS), so a swapped path fails instead of writing elsewhere.
//
// An empty key list empties an existing file rather than leaving it alone: the
// file is merged into the project's effective keys, so a key list that went
// from one key to none must not keep the removed key.
export async function writeManagedAuthorizedKeysFile(
  home: string,
  keys?: string,
): Promise<void> {
  const content = (keys ?? "").trim();
  const formatted = content
    ? content.endsWith("\n")
      ? content
      : `${content}\n`
    : "";
  const managedDir = INTERNAL_SSH_CONFIG;
  const managedPath = join(managedDir, "authorized_keys");
  const root = new SandboxRoot(home);
  if (!formatted) {
    // Nothing to empty unless the file (or a symlink in its place) exists.
    // The directory is checked first, so a symlinked parent still fails
    // closed, while a symlinked file is replaced like any other.
    try {
      root.stat(managedDir);
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }
    try {
      root.stat(managedPath);
    } catch (err) {
      if (isMissing(err)) return;
      if (!isSymlinkRefusal(err)) throw err;
    }
  }
  root.mkdir(managedDir, true, 0o700);
  root.chmod(managedDir, 0o700);
  const tmpPath = join(managedDir, `.tmp-authorized_keys-${randomUUID()}`);
  try {
    const fd = root.openWrite(tmpPath, true, true, false, 0o600);
    try {
      const data = Buffer.from(formatted);
      let offset = 0;
      while (offset < data.length) {
        offset += writeSync(fd, data, offset, data.length - offset);
      }
    } finally {
      closeSync(fd);
    }
    root.chmod(tmpPath, 0o600);
    root.rename(tmpPath, managedPath);
  } catch (err) {
    try {
      root.unlink(tmpPath);
    } catch {}
    throw err;
  }
}
