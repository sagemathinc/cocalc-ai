import { isAbsolutePath, normalizeAbsolutePath } from "@cocalc/util/path-model";

interface PathContextEntry {
  kind: string;
  workingDirectory?: string;
  cwd?: string;
}

function absolute(path?: string): string | undefined {
  return path && isAbsolutePath(path) ? normalizeAbsolutePath(path) : undefined;
}

/** A subprocess cwd is local to its event, not a change to the agent's cwd. */
export function activityPathContexts(
  entries: readonly PathContextEntry[],
  fallback?: string,
): (string | undefined)[] {
  let directory = absolute(fallback);
  return entries.map((entry) => {
    if (entry.kind === "config")
      directory = absolute(entry.workingDirectory) ?? directory;
    if (entry.kind === "terminal" || entry.kind === "file")
      return absolute(entry.cwd) ?? directory;
    return directory;
  });
}
