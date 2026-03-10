function toEntries(history: any): any[] {
  if (Array.isArray(history)) return history;
  if (typeof history?.toArray === "function") return history.toArray();
  if (typeof history?.toJS === "function") return history.toJS();
  return [];
}

function toMs(value: unknown): number | undefined {
  const ms =
    value instanceof Date
      ? value.valueOf()
      : typeof value === "number"
        ? value
        : new Date(value as any).valueOf();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

function formatElapsedMs(elapsed: number): string {
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${minutes}:${pad(seconds)}`;
}

export function formatTurnDuration({
  startMs,
  history,
}: {
  startMs?: number;
  history?: any;
}): string {
  const entries = toEntries(history);
  if (!entries.length) return "";
  const historyTimes = entries
    .map((entry) =>
      toMs(entry?.date ?? (typeof entry?.get === "function" ? entry.get("date") : undefined)),
    )
    .filter((value): value is number => value != null)
    .sort((a, b) => a - b);
  if (!historyTimes.length) return "";
  const earliestHistoryMs = historyTimes[0];
  const latestHistoryMs = historyTimes[historyTimes.length - 1];
  const start =
    historyTimes.length >= 2
      ? earliestHistoryMs
      : Number.isFinite(startMs) && (startMs as number) > 0
        ? (startMs as number)
        : earliestHistoryMs;
  const elapsed = Math.max(0, latestHistoryMs - start);
  if (!Number.isFinite(elapsed) || elapsed <= 0) return "";
  return formatElapsedMs(elapsed);
}
