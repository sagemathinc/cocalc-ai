/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project runtime rewrites its own log and pid file (so their directory
// changes too) while it runs and when it stops. Only these are not a change
// to the project's files; anything else, hidden or not, is.
const RUNTIME_DIR = ".cache/cocalc/project";
const RUNTIME_FILES = new Set([
  `${RUNTIME_DIR}/log`,
  `${RUNTIME_DIR}/project.pid`,
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
  const runtimeFileChanged = paths.some((path) => RUNTIME_FILES.has(path));
  return paths.some(
    (path) =>
      !RUNTIME_FILES.has(path) &&
      // their directory changes when the runtime replaces one of them
      !(path === RUNTIME_DIR && runtimeFileChanged),
  );
}
