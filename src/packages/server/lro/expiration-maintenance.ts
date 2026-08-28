/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { expireDueLros, expireOrphanedProjectBackupLros } from "./lro-db";

const DEFAULT_INTERVAL_MS = 30_000;
const BATCH_SIZE = 1000;
const MAX_BATCHES_PER_TICK = 10;

const logger = getLogger("server:lro:expiration-maintenance");

let started = false;
let running = false;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export async function runLroExpirationMaintenanceOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  let total = 0;
  try {
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const expired = await expireOrphanedProjectBackupLros({
        limit: BATCH_SIZE,
      });
      total += expired.length;
      if (expired.length < BATCH_SIZE) break;
    }
    for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
      const expired = await expireDueLros({ limit: BATCH_SIZE });
      total += expired.length;
      if (expired.length < BATCH_SIZE) break;
    }
    if (total > 0) {
      logger.info("expired long-running operations", { count: total });
    }
    return total;
  } catch (err) {
    logger.warn("long-running operation expiration maintenance failed", {
      err: `${err}`,
    });
    return total;
  } finally {
    running = false;
  }
}

export function startLroExpirationMaintenance(): void {
  if (started) return;
  started = true;
  const interval = positiveIntegerEnv(
    "COCALC_LRO_EXPIRATION_MAINTENANCE_INTERVAL_MS",
    DEFAULT_INTERVAL_MS,
  );
  void runLroExpirationMaintenanceOnce();
  const timer = setInterval(() => {
    void runLroExpirationMaintenanceOnce();
  }, interval);
  timer.unref?.();
}

export const __test__ = {
  reset: () => {
    started = false;
    running = false;
  },
};
