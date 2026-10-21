/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
A project's persist databases live in the project (COCALC_SYNC_PROJECTS, e.g.,
/mnt/cocalc/project-[project_id]/.local/share/cocalc/persist), so the project
can put anything at those paths: symlinks to other files, FIFOs, devices.

Before the persist server opens (or copies) a database there, refuse anything
but real directories below the project root and regular files for the
database and its -wal, -shm and -journal files.

This narrows the problem but does not remove it: a project can still swap a
file between this check and the open.  The complete fix is keeping these
files out of projects.
*/

import { lstatSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { syncFiles } from "@cocalc/backend/data";

const PLACEHOLDER = "[project_id]";

// The project root (which the project can't replace) containing path, if path
// is under the project persist template.
export function projectRootForPersistPath(
  path: string,
  template: string = syncFiles.localProjects,
): string | undefined {
  if (!template?.includes(PLACEHOLDER)) return;
  // Compare normalized paths: a doubled "/" or a ".." in either one must not
  // hide that path is in a project.
  path = resolve(path);
  const [prefix, suffix] = resolve(template).split(PLACEHOLDER);
  if (!prefix || !path.startsWith(prefix)) return;
  // e.g., "-persist" in /mnt/cocalc/project-[project_id]-persist/...
  const suffixRoot = suffix.split(sep)[0] ?? "";
  const segment = path.slice(prefix.length).split(sep)[0];
  if (!segment || !segment.endsWith(suffixRoot)) return;
  if (segment.length === suffixRoot.length) return;
  return prefix + segment;
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw err;
  }
}

function unsafe(path: string, why: string): Error {
  return new Error(`unsafe persist database path: ${path} ${why}`);
}

export function assertSafePersistDatabasePath(
  path: string,
  template: string = syncFiles.localProjects,
): void {
  path = resolve(path);
  const root = projectRootForPersistPath(path, template);
  if (root == null) {
    // not in a project: a directory only the host writes
    return;
  }
  const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw unsafe(path, "is not inside its project");
  }
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    current = join(current, part);
    const stat = lstatIfExists(current);
    if (stat == null) {
      // not created yet, so there is nothing to open below it
      return;
    }
    if (!stat.isDirectory()) {
      throw unsafe(current, "is not a directory");
    }
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    const stat = lstatIfExists(file);
    if (stat != null && !stat.isFile()) {
      throw unsafe(file, "is not a regular file");
    }
  }
}
