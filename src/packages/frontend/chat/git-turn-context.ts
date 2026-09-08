import { containingPath } from "@cocalc/util/misc";

export function gitReviewOrigin(
  sourcePath?: string,
  directory?: string,
): string {
  return directory || containingPath(sourcePath ?? ".") || ".";
}

// Resolve a historical turn before falling back to the thread's current hint.
export function recordedTurnDirectory(events: unknown): string | undefined {
  const rows = (events as any)?.toJS?.() ?? events;
  if (!Array.isArray(rows)) return undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const event = rows[i]?.event;
    if (
      event?.type === "config" &&
      typeof event.workingDirectory === "string" &&
      event.workingDirectory.length > 0
    ) {
      return event.workingDirectory;
    }
  }
  return undefined;
}

export async function resolveGitTurnDirectory({
  events,
  loadEvents,
  fallback,
}: {
  events: unknown;
  loadEvents?: () => Promise<unknown>;
  fallback?: string;
}): Promise<string | undefined> {
  const recorded = recordedTurnDirectory(events);
  if (recorded !== undefined) return recorded;
  // A message preview may omit config events. Fetch only on explicit opening,
  // not for every visible message. Transport failures must not redirect a link.
  return (loadEvents && recordedTurnDirectory(await loadEvents())) || fallback;
}
