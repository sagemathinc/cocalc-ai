import { getLogger } from "./logger";

type CounterMap = Map<string, number>;

type TrackOptions = {
  source: string;
  type: string;
  path?: string;
  info?: Record<string, unknown>;
};

type ActiveWatcher = {
  id: number;
  source: string;
  type: string;
  path?: string;
  info?: Record<string, unknown>;
  createdAt: number;
};

const logger = getLogger("backend:watcher-debug");

const counters = {
  created: 0,
  closed: 0,
  active: 0,
  closeUnknown: 0,
};

let nextId = 1;

const active = new Map<number, ActiveWatcher>();
const activeBySource: CounterMap = new Map();
const activeByType: CounterMap = new Map();
const activeByPath: CounterMap = new Map();

const createdBySource: CounterMap = new Map();
const closedBySource: CounterMap = new Map();

function bump(map: CounterMap, key: string | undefined, delta: number): void {
  if (!key) return;
  const value = (map.get(key) ?? 0) + delta;
  if (value <= 0) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

function topCounters(map: CounterMap, topN: number, keyName: string) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => ({ [keyName]: key, count }));
}

function infoNumber(
  info: Record<string, unknown> | undefined,
  key: string,
): number {
  if (info == null) return 0;
  const value = info[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export function trackBackendWatcher(opts: TrackOptions): () => void {
  const source = opts.source || "unknown";
  const type = opts.type || "unknown";
  const path = opts.path;
  const info = opts.info;
  const createdAt = Date.now();
  const id = nextId++;

  counters.created += 1;
  counters.active += 1;
  bump(createdBySource, source, 1);
  bump(activeBySource, source, 1);
  bump(activeByType, type, 1);
  bump(activeByPath, path, 1);
  active.set(id, {
    id,
    source,
    type,
    path,
    info,
    createdAt,
  });

  let closed = false;
  return () => {
    if (closed) {
      return;
    }
    closed = true;
    const existing = active.get(id);
    if (!existing) {
      counters.closeUnknown += 1;
      logger.warn("close of unknown backend watcher", { id, source, type, path });
      return;
    }
    active.delete(id);
    counters.closed += 1;
    counters.active = Math.max(0, counters.active - 1);
    bump(closedBySource, source, 1);
    bump(activeBySource, source, -1);
    bump(activeByType, type, -1);
    bump(activeByPath, path, -1);
  };
}

export function getBackendWatcherDebugStats({
  topN = 8,
}: {
  topN?: number;
} = {}) {
  const top = Math.max(1, topN);
  const now = Date.now();
  const oldestActiveTop = Array.from(active.values())
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, top)
    .map((w) => ({
      id: w.id,
      source: w.source,
      type: w.type,
      path: w.path,
      ageMs: Math.max(0, now - w.createdAt),
      info: w.info,
    }));
  let watchedEntriesTotal = 0;
  let watchedDirsTotal = 0;
  const watchedEntriesByPathTop = Array.from(active.values())
    .map((w) => {
      const watchedEntries = infoNumber(w.info, "watchedEntries");
      const watchedDirs = infoNumber(w.info, "watchedDirs");
      watchedEntriesTotal += watchedEntries;
      watchedDirsTotal += watchedDirs;
      return {
        id: w.id,
        source: w.source,
        type: w.type,
        path: w.path,
        watchedEntries,
        watchedDirs,
      };
    })
    .filter((w) => w.watchedEntries > 0 || w.watchedDirs > 0)
    .sort((a, b) => {
      if (b.watchedEntries !== a.watchedEntries) {
        return b.watchedEntries - a.watchedEntries;
      }
      return b.watchedDirs - a.watchedDirs;
    })
    .slice(0, top);
  return {
    ...counters,
    sourcesActive: activeBySource.size,
    activeBySourceTop: topCounters(activeBySource, top, "source"),
    activeByTypeTop: topCounters(activeByType, top, "type"),
    activeByPathTop: topCounters(activeByPath, top, "path"),
    watchedEntriesTotal,
    watchedDirsTotal,
    watchedEntriesByPathTop,
    createdBySourceTop: topCounters(createdBySource, top, "source"),
    closedBySourceTop: topCounters(closedBySource, top, "source"),
    oldestActiveTop,
  };
}
