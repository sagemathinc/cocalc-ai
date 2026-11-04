/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import * as metrics from "@cocalc/backend/metrics";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  artifactCatalogChangeRowGauges,
  backfillArtifactCatalogChangeRows,
  backfillArtifactCatalogProjectState,
  pruneArtifactCatalogChanges,
} from "@cocalc/database/postgres/artifact-catalog";
import { ensureArtifactCatalogChangeCheck } from "@cocalc/database/postgres/schema/artifact-catalog-change-check";

const log = getLogger("artifacts:catalog-maintenance");

let stopRunning: (() => void) | undefined;

let gauges: Record<string, any> | undefined;
function reportGauges(values: Record<string, number>) {
  gauges ??= {
    max_change_rows: metrics.newGauge(
      "server",
      "artifact_catalog_max_change_rows",
      "Largest retained change-row count of any artifact catalog on this bay.",
    ),
    projects_over_retention: metrics.newGauge(
      "server",
      "artifact_catalog_projects_over_change_rows",
      "Artifact catalogs retaining more than 10k change rows.",
    ),
    projects_unmeasured: metrics.newGauge(
      "server",
      "artifact_catalog_projects_unmeasured_change_rows",
      "Artifact catalogs whose change-row count is not yet measured.",
    ),
    change_check_validated: metrics.newGauge(
      "server",
      "artifact_catalog_change_check_validated",
      "1 when the change log constraint is validated (deltas served), else 0.",
    ),
  };
  for (const [name, value] of Object.entries(values)) gauges[name].set(value);
}

const SLOW_MS = 10 * 60_000;
let lastSlow = 0;

/**
 * Every 10 minutes at most: tries to validate the change-log constraint
 * (deltas stay off until it is), and reports change-row gauges, counts only,
 * from the state table.
 */
async function slowTick(now: number) {
  if (now - lastSlow < SLOW_MS) return;
  lastSlow = now;
  const validated = await ensureArtifactCatalogChangeCheck(getPool());
  reportGauges({
    ...(await artifactCatalogChangeRowGauges()),
    change_check_validated: validated ? 1 : 0,
  });
}

/**
 * On this bay: gives every existing catalog a version baseline (catalogs
 * written before versions existed), measures change-row counts that predate
 * the counter, prunes the change log, all in small batches, and every 10
 * minutes validates the change-log constraint and reports gauges.
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
      const backfill = await backfillArtifactCatalogProjectState({
        owning_bay_id: getConfiguredBayId(),
      });
      if (backfill.created > 0 || backfill.remaining > 0) {
        log.info("artifact catalog version backfill", backfill);
      }
      const measured = await backfillArtifactCatalogChangeRows();
      const pruned = await pruneArtifactCatalogChanges();
      await slowTick(Date.now());
      // More work may be waiting; continue soon, still in small batches.
      if (
        backfill.remaining > 0 ||
        measured.remaining > 0 ||
        pruned.projects > 0
      )
        delay = 5_000;
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
