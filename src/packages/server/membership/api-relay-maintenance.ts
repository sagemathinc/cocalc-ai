/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { cleanupApiRelayQuota } from "./api-relay-quota";

const logger = getLogger("server:membership:api-relay-maintenance");
let stop: (() => void) | undefined;

export function startApiRelayQuotaMaintenance({
  cleanup = cleanupApiRelayQuota,
  intervalMs = 30_000,
}: {
  cleanup?: typeof cleanupApiRelayQuota;
  intervalMs?: number;
} = {}): () => void {
  if (stop) return stop;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      const removed = await cleanup();
      if (removed.leases || removed.accounts)
        logger.debug("cleaned relay quota records", removed);
    } catch (err) {
      logger.warn("relay quota cleanup failed", { err: `${err}` });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => void run(), intervalMs);
        timer.unref();
      }
    }
  };
  stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stop = undefined;
  };
  void run();
  return stop;
}
