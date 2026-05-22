/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  listSiteLicenseIdsWithAffiliationReverification,
  notifySiteLicenseAffiliationReverificationSeatsForSystem,
  notifySiteLicenseAffiliationSeatReleasesForSystem,
  releaseGraceExpiredSiteLicenseAffiliationSeatsForSystem,
} from "@cocalc/server/membership/site-licenses";

const logger = getLogger("server:membership:site-license-affiliation");

const ENABLED =
  `${process.env.COCALC_SITE_LICENSE_AFFILIATION_RELEASE_ENABLED ?? "1"}`.trim() !==
  "0";
const INTERVAL_MS = clampInt(
  process.env.COCALC_SITE_LICENSE_AFFILIATION_RELEASE_INTERVAL_MS,
  24 * 60 * 60_000,
  60_000,
  7 * 24 * 60 * 60_000,
);
const SITE_LICENSE_BATCH_LIMIT = clampInt(
  process.env.COCALC_SITE_LICENSE_AFFILIATION_RELEASE_SITE_LICENSE_LIMIT,
  10_000,
  1,
  100_000,
);
const SEAT_BATCH_LIMIT = clampInt(
  process.env.COCALC_SITE_LICENSE_AFFILIATION_RELEASE_SEAT_LIMIT,
  100,
  1,
  500,
);

let timer: NodeJS.Timeout | undefined;
let running = false;

export interface SiteLicenseAffiliationReleaseMaintenanceResult {
  scanned_site_licenses: number;
  site_licenses_with_notifications: number;
  notified_seats: number;
  site_licenses_with_releases: number;
  released_seats: number;
  failed_site_licenses: number;
}

function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function runSiteLicenseAffiliationReleaseMaintenancePass({
  now = new Date(),
  site_license_limit = SITE_LICENSE_BATCH_LIMIT,
  seat_limit = SEAT_BATCH_LIMIT,
  list_site_license_ids = listSiteLicenseIdsWithAffiliationReverification,
  notify_reverification = notifySiteLicenseAffiliationReverificationSeatsForSystem,
  release_grace_expired = releaseGraceExpiredSiteLicenseAffiliationSeatsForSystem,
  notify_releases = notifySiteLicenseAffiliationSeatReleasesForSystem,
}: {
  now?: Date;
  site_license_limit?: number;
  seat_limit?: number;
  list_site_license_ids?: typeof listSiteLicenseIdsWithAffiliationReverification;
  notify_reverification?: typeof notifySiteLicenseAffiliationReverificationSeatsForSystem;
  release_grace_expired?: typeof releaseGraceExpiredSiteLicenseAffiliationSeatsForSystem;
  notify_releases?: typeof notifySiteLicenseAffiliationSeatReleasesForSystem;
} = {}): Promise<SiteLicenseAffiliationReleaseMaintenanceResult> {
  const siteLicenseIds = await list_site_license_ids({
    limit: site_license_limit,
  });
  const result: SiteLicenseAffiliationReleaseMaintenanceResult = {
    scanned_site_licenses: siteLicenseIds.length,
    site_licenses_with_notifications: 0,
    notified_seats: 0,
    site_licenses_with_releases: 0,
    released_seats: 0,
    failed_site_licenses: 0,
  };
  for (const site_license_id of siteLicenseIds) {
    try {
      const notified = await notify_reverification({
        site_license_id,
        now,
        limit: seat_limit,
      });
      if (notified.length > 0) {
        result.site_licenses_with_notifications += 1;
        result.notified_seats += notified.length;
      }
      const released = await release_grace_expired({
        site_license_id,
        now,
        limit: seat_limit,
      });
      if (released.length > 0) {
        result.site_licenses_with_releases += 1;
        result.released_seats += released.length;
        await notify_releases({
          site_license_id,
          seats: released,
        });
      }
    } catch (err) {
      result.failed_site_licenses += 1;
      logger.error("site-license affiliation release failed", {
        site_license_id,
        err,
      });
    }
  }
  return result;
}

export async function runSiteLicenseAffiliationReleaseMaintenanceTick(): Promise<SiteLicenseAffiliationReleaseMaintenanceResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await runSiteLicenseAffiliationReleaseMaintenancePass();
    if (
      result.notified_seats > 0 ||
      result.released_seats > 0 ||
      result.failed_site_licenses > 0
    ) {
      logger.info("site-license affiliation release maintenance tick", result);
    }
    return result;
  } finally {
    running = false;
  }
}

export function startSiteLicenseAffiliationReleaseMaintenance(): void {
  if (!ENABLED) {
    logger.info("site-license affiliation release maintenance disabled");
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    void runSiteLicenseAffiliationReleaseMaintenanceTick();
  }, INTERVAL_MS);
  timer.unref?.();
  void runSiteLicenseAffiliationReleaseMaintenanceTick();
  logger.info("site-license affiliation release maintenance started", {
    interval_ms: INTERVAL_MS,
    site_license_batch_limit: SITE_LICENSE_BATCH_LIMIT,
    seat_batch_limit: SEAT_BATCH_LIMIT,
  });
}

export function stopSiteLicenseAffiliationReleaseMaintenance(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}

export function resetSiteLicenseAffiliationReleaseMaintenanceStateForTests(): void {
  stopSiteLicenseAffiliationReleaseMaintenance();
  running = false;
}
