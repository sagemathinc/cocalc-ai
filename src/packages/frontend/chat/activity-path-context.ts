import { isAbsolutePath, normalizeAbsolutePath } from "@cocalc/util/path-model";
import type { AcpStreamMessage } from "@cocalc/conat/ai/acp/types";

interface PathContextEntry {
  kind: string;
  workingDirectory?: string;
  cwd?: string;
}

function absolute(path?: string): string | undefined {
  return path && isAbsolutePath(path) ? normalizeAbsolutePath(path) : undefined;
}

/** Prefer the historical turn's cwd over mutable preferences for future turns. */
export function agentMessageDirectory({
  workingDirectory,
  events,
  fallback,
}: {
  workingDirectory?: string;
  events?: readonly AcpStreamMessage[] | null;
  fallback?: string;
}): string | undefined {
  const persisted = absolute(workingDirectory);
  if (persisted) return persisted;
  for (const entry of events ?? []) {
    if (entry.type !== "event" || entry.event.type !== "config") continue;
    const directory = absolute(entry.event.workingDirectory);
    if (directory) return directory;
  }
  return absolute(fallback);
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
