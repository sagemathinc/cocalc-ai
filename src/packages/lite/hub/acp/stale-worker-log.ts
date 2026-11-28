/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import { LogRateLimiter } from "@cocalc/backend/log-rate-limit";

const limiter = new LogRateLimiter({ intervalMs: 60_000, maxKeys: 1000 });

/**
 * Liveness checks run on every queue and recovery pass, so this line could
 * repeat many times per millisecond. Log it once a minute per worker.
 * Logging only: callers make the liveness decision themselves.
 */
export function logStaleWorkerTreatedAsLive(
  logger: { debug: (...args: any[]) => void },
  fields: {
    worker_id: string;
    pid?: number | null;
    age_ms: number;
    grace_ms: number;
  },
): void {
  const suppressed = limiter.take(fields.worker_id);
  if (suppressed == null) return;
  logger.debug(
    "treating stale ACP worker as still live because its pid exists",
    { ...fields, ...(suppressed ? { suppressed } : {}) },
  );
}
