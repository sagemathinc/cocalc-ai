/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { loadConatConfiguration } from "@cocalc/server/conat/configuration";
import { getInterBayFabricConfig } from "@cocalc/server/inter-bay/fabric";
import { initInterBayServices } from "@cocalc/server/inter-bay/service";

const logger = getLogger("server:inter-bay:dev-listener");
const HOST_PIN_INTERVAL_MS = 5_000;

function getPinnedHostIds(): string[] {
  return `${process.env.COCALC_INTER_BAY_DEV_PIN_HOST_IDS ?? ""}`
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function pinHostsToConfiguredBay(hostIds: string[]): Promise<void> {
  if (hostIds.length === 0) {
    return;
  }
  const bay_id = getConfiguredBayId();
  const pool = getPool();
  for (const host_id of hostIds) {
    await pool.query(
      "UPDATE project_hosts SET bay_id=$2 WHERE id=$1 AND deleted IS NULL",
      [host_id, bay_id],
    );
  }
  logger.info("pinned dev host bay assignments", {
    bay_id,
    host_ids: hostIds,
  });
}

function startPinnedHostLoop(hostIds: string[]): void {
  if (hostIds.length === 0) {
    return;
  }
  void pinHostsToConfiguredBay(hostIds).catch((err) => {
    logger.warn("initial host pin failed", {
      err: `${err}`,
      host_ids: hostIds,
    });
  });
  const timer = setInterval(() => {
    void pinHostsToConfiguredBay(hostIds).catch((err) => {
      logger.warn("failed refreshing host pin", {
        err: `${err}`,
        host_ids: hostIds,
      });
    });
  }, HOST_PIN_INTERVAL_MS);
  timer.unref?.();
}

async function main() {
  await loadConatConfiguration();
  await initInterBayServices();
  startPinnedHostLoop(getPinnedHostIds());
  logger.info("inter-bay dev listener ready", {
    bay_id: getConfiguredBayId(),
    fabric: getInterBayFabricConfig().address,
    pinned_host_ids: getPinnedHostIds(),
  });
  await new Promise(() => {});
}

void main().catch((err) => {
  logger.error("inter-bay dev listener failed", { err: `${err}` });
  process.exit(1);
});
