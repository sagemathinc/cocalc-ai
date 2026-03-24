/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";

import { runPendingRootfsReleaseGc } from "./releases";

const logger = getLogger("server:rootfs:gc-maintenance");
const CHECK_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_ROOTFS_RELEASE_GC_INTERVAL_MS ?? 5 * 60_000),
);
const BATCH_LIMIT = Math.max(
  1,
  Math.min(
    1_000,
    Number(process.env.COCALC_ROOTFS_RELEASE_GC_BATCH_LIMIT ?? 25),
  ),
);
const LOCK_KEY = "rootfs_release_gc_maintenance";

let started = false;

async function withMaintenanceLock<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const pool = getPool("medium");
  const { rows } = await pool.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [LOCK_KEY],
  );
  if (!rows[0]?.locked) {
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
  }
}

export function startRootfsReleaseGcMaintenance(): void {
  if (started) {
    return;
  }
  started = true;
  logger.info("starting RootFS release GC maintenance loop", {
    CHECK_INTERVAL_MS,
    BATCH_LIMIT,
  });
  const run = async () => {
    try {
      const result = await withMaintenanceLock(async () => {
        return await runPendingRootfsReleaseGc({ limit: BATCH_LIMIT });
      });
      if (!result) {
        return;
      }
      if (
        result.scanned > 0 ||
        result.deleted > 0 ||
        result.blocked > 0 ||
        result.failed > 0
      ) {
        logger.info("RootFS release GC maintenance completed", result);
      }
    } catch (err) {
      logger.error("RootFS release GC maintenance failed", err);
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}
