/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project runtime rewrites its own log and pid file while it runs and
// when it stops. Only these are not a change to the project's files; anything
// else, hidden or not, is. Their directory is not ignored: a file deleted or
// renamed there shows only as the directory's change.
const RUNTIME_FILES = new Set([
  ".cache/cocalc/project/log",
  ".cache/cocalc/project/project.pid",
]);

/** Whether a change scan's paths (project-relative, "." for the top) show a
 * change besides the runtime's own files. A truncated scan always does. */
export function changedBeyondRuntimeFiles({
  paths,
  truncated,
}: {
  paths: string[];
  truncated: boolean;
}): boolean {
  if (truncated) return true;
  return paths.some((path) => !RUNTIME_FILES.has(path));
}
