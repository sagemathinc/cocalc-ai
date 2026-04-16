import getLogger from "@cocalc/backend/logger";
import {
  constants as perfConstants,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";

const SAMPLE_INTERVAL_MS = 100;
const WARN_THRESHOLDS_MS = [250, 1000, 4000] as const;
const GC_SHORT_WINDOW_MS = 5_000;
const GC_LONG_WINDOW_MS = 30_000;

type GcEvent = {
  ended_at_ms: number;
  duration_ms: number;
  kind: string;
};

function activeHandleCount(): number | undefined {
  try {
    return (process as any)?._getActiveHandles?.().length;
  } catch {
    return;
  }
}

function gcKindName(kind: number | undefined): string {
  switch (kind) {
    case perfConstants.NODE_PERFORMANCE_GC_MAJOR:
      return "major";
    case perfConstants.NODE_PERFORMANCE_GC_MINOR:
      return "minor";
    case perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return "incremental";
    case perfConstants.NODE_PERFORMANCE_GC_WEAKCB:
      return "weakcb";
    default:
      return "unknown";
  }
}

function pruneGcEvents(events: GcEvent[], nowMs: number): GcEvent[] {
  return events.filter(
    (event) => nowMs - event.ended_at_ms <= GC_LONG_WINDOW_MS,
  );
}

function summarizeGcEvents(events: GcEvent[], nowMs: number) {
  const retained = pruneGcEvents(events, nowMs);
  if (!retained.length) {
    return {};
  }
  const sumWindow = (windowMs: number) =>
    Math.round(
      retained
        .filter((event) => nowMs - event.ended_at_ms <= windowMs)
        .reduce((sum, event) => sum + event.duration_ms, 0),
    );
  const last = retained[retained.length - 1];
  return {
    last_gc_kind: last?.kind,
    last_gc_duration_ms: Math.round(last?.duration_ms ?? 0),
    last_gc_ago_ms: Math.max(
      0,
      Math.round(nowMs - (last?.ended_at_ms ?? nowMs)),
    ),
    gc_total_ms_5s: sumWindow(GC_SHORT_WINDOW_MS),
    gc_total_ms_30s: sumWindow(GC_LONG_WINDOW_MS),
    gc_major_count_30s: retained.filter((event) => event.kind === "major")
      .length,
  };
}

function createGcTracker() {
  let events: GcEvent[] = [];
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        events.push({
          ended_at_ms: entry.startTime + entry.duration,
          duration_ms: entry.duration,
          kind: gcKindName((entry as any)?.kind),
        });
      }
      events = pruneGcEvents(events, performance.now());
    });
    observer.observe({ entryTypes: ["gc"] as any });
  } catch {
    observer = undefined;
  }
  return {
    snapshot(nowMs: number) {
      events = pruneGcEvents(events, nowMs);
      return summarizeGcEvents(events, nowMs);
    },
    stop() {
      observer?.disconnect();
    },
  };
}

function snapshotForLag(lagMs: number, gcSnapshot: Record<string, any>) {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    lag_ms: Math.round(lagMs),
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
    active_handles: activeHandleCount(),
    uptime_s: Math.round(process.uptime()),
    host_id: `${process.env.PROJECT_HOST_ID ?? ""}`.trim() || null,
    ...gcSnapshot,
  };
}

export function startProjectHostEventLoopStallMonitor(): () => void {
  return startEventLoopStallMonitor({
    loggerName: "project-host:event-loop-stalls",
    label: "project-host",
  });
}

export function startEventLoopStallMonitor({
  loggerName,
  label,
  sampleIntervalMs = SAMPLE_INTERVAL_MS,
  warnThresholdsMs = WARN_THRESHOLDS_MS,
}: {
  loggerName: string;
  label: string;
  sampleIntervalMs?: number;
  warnThresholdsMs?: readonly number[];
}): () => void {
  const logger = getLogger(loggerName);
  const thresholds = [...warnThresholdsMs].sort((a, b) => a - b);
  const gcTracker = createGcTracker();
  let expected = performance.now() + sampleIntervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = Math.max(0, now - expected);
    expected = now + sampleIntervalMs;
    const threshold = thresholds.find((value) => lagMs >= value);
    if (threshold == null) {
      return;
    }
    logger.warn(`${label} event loop stall detected`, {
      component: label,
      threshold_ms: threshold,
      ...snapshotForLag(lagMs, gcTracker.snapshot(now)),
    });
  }, sampleIntervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    gcTracker.stop();
  };
}

export const __test__ = {
  gcKindName,
  summarizeGcEvents,
  pruneGcEvents,
};
