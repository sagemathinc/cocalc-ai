import getLogger from "@cocalc/backend/logger";
import { performance } from "node:perf_hooks";

const SAMPLE_INTERVAL_MS = 100;
const WARN_THRESHOLDS_MS = [250, 1000, 4000] as const;

function activeHandleCount(): number | undefined {
  try {
    return (process as any)?._getActiveHandles?.().length;
  } catch {
    return;
  }
}

function snapshotForLag(lagMs: number) {
  const memory = process.memoryUsage();
  return {
    pid: process.pid,
    lag_ms: Math.round(lagMs),
    rss_mb: Math.round(memory.rss / 1024 / 1024),
    heap_used_mb: Math.round(memory.heapUsed / 1024 / 1024),
    active_handles: activeHandleCount(),
    uptime_s: Math.round(process.uptime()),
    host_id: `${process.env.PROJECT_HOST_ID ?? ""}`.trim() || null,
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
      ...snapshotForLag(lagMs),
    });
  }, sampleIntervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
