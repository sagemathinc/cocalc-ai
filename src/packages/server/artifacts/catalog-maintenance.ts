/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { pruneArtifactCatalogChanges } from "@cocalc/database/postgres/artifact-catalog";

const log = getLogger("artifacts:catalog-maintenance");

let stopRunning: (() => void) | undefined;

/** Prunes the artifact catalog change log in small batches on this bay. */
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
      const result = await pruneArtifactCatalogChanges();
      // More projects may be waiting; continue soon, still in small batches.
      if (result.projects > 0) delay = 5_000;
    } catch (error) {
      log.warn("artifact catalog change pruning failed", { error });
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
