/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";

// Writes the managed authorized_keys file in a project's home. An empty key
// list empties an existing file rather than leaving it alone: the file is
// merged into the project's effective keys, so a key list that went from one
// key to none must not keep the removed key.
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
  const managedDir = join(home, INTERNAL_SSH_CONFIG);
  const managedPath = join(managedDir, "authorized_keys");
  if (!formatted) {
    try {
      await lstat(managedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }
  }
  await mkdir(managedDir, { recursive: true, mode: 0o700 });
  await chmod(managedDir, 0o700).catch(() => {});
  const tmpPath = join(managedDir, `.tmp-authorized_keys-${randomUUID()}`);
  try {
    await writeFile(tmpPath, formatted, { mode: 0o600 });
    await chmod(tmpPath, 0o600).catch(() => {});
    await rename(tmpPath, managedPath);
    await chmod(managedPath, 0o600).catch(() => {});
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }
}
