/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  backfillArtifactCatalogProjectState,
  pruneArtifactCatalogChanges,
} from "@cocalc/database/postgres/artifact-catalog";

const log = getLogger("artifacts:catalog-maintenance");

let stopRunning: (() => void) | undefined;

/**
 * On this bay: gives every existing catalog a version baseline (catalogs
 * written before versions existed), then prunes the change log, both in
 * small batches.
 */
export function startArtifactCatalogMaintenance(): () => void {
  if (stopRunning) return stopRunning;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (delay: number) => {
    timer = setTimeout(tick, delay);
    timer.unref?.();
  };
  const tick = async () => {
    let delay = 10 * 60_000;
    try {
      const backfill = await backfillArtifactCatalogProjectState();
      if (backfill.created > 0 || backfill.remaining > 0) {
        log.info("artifact catalog version backfill", backfill);
      }
      const pruned = await pruneArtifactCatalogChanges();
      // More work may be waiting; continue soon, still in small batches.
      if (backfill.remaining > 0 || pruned.projects > 0) delay = 5_000;
    } catch (error) {
      log.warn("artifact catalog maintenance failed", { error });
    }
    if (!stopped) schedule(delay);
  };
  stopRunning = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    stopRunning = undefined;
  };
  schedule(60_000);
  return stopRunning;
}
