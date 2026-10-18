/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { chmod, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// Owner bits rsync needs to copy an extracted tree: directories must be
// listable, searchable and (for cleanup) writable; regular files readable.
const DIRECTORY_OWNER_BITS = 0o700;
const FILE_OWNER_BITS = 0o400;

export interface OwnerAccessResult {
  adjusted_count: number;
  adjusted_paths: string[];
}

/*
Legacy archives can contain directories without owner search permission or
files without owner read permission (e.g. a course exercise on file modes).
tar restores those modes, and the later rsync from the staging tree then fails
with exit 23, aborting the whole restore. Add only the missing owner bits so
the staging tree can be copied; group/other bits and write bits on files are
left alone. Symlinks are never followed or changed, and managed roots
(relative to root) are skipped because they are excluded from the copy.
*/
export async function grantOwnerAccessToExtractedTree({
  root,
  exclude,
  reportLimit = 100,
}: {
  root: string;
  exclude?: string[];
  reportLimit?: number;
}): Promise<OwnerAccessResult> {
  const adjusted_paths: string[] = [];
  let adjusted_count = 0;
  const isExcluded = (rel: string) =>
    exclude?.some((entry) => rel === entry || rel.startsWith(`${entry}/`)) ??
    false;
  const ensureBits = async (
    path: string,
    rel: string,
    mode: number,
    bits: number,
  ) => {
    if ((mode & bits) === bits) return;
    await chmod(path, (mode & 0o7777) | bits);
    adjusted_count += 1;
    if (adjusted_paths.length < reportLimit) adjusted_paths.push(rel);
  };
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`extracted archive root is not a directory: ${root}`);
  }
  await ensureBits(root, ".", rootStat.mode, DIRECTORY_OWNER_BITS);
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const dir = relDir ? join(root, relDir) : root;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcluded(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Fix the directory before descending, since reading it needs r+x.
        await ensureBits(
          path,
          rel,
          (await lstat(path)).mode,
          DIRECTORY_OWNER_BITS,
        );
        stack.push(rel);
      } else if (entry.isFile()) {
        await ensureBits(path, rel, (await lstat(path)).mode, FILE_OWNER_BITS);
      }
    }
  }
  return { adjusted_count, adjusted_paths };
}
