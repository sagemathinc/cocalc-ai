import getLogger from "@cocalc/backend/logger";
import { performance } from "node:perf_hooks";

const logger = getLogger("project-host:event-loop-stalls");
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
  let expected = performance.now() + SAMPLE_INTERVAL_MS;
  const timer = setInterval(() => {
    const now = performance.now();
    const lagMs = Math.max(0, now - expected);
    expected = now + SAMPLE_INTERVAL_MS;
    const threshold = WARN_THRESHOLDS_MS.find((value) => lagMs >= value);
    if (threshold == null) {
      return;
    }
    logger.warn("project-host event loop stall detected", {
      threshold_ms: threshold,
      ...snapshotForLag(lagMs),
    });
  }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
