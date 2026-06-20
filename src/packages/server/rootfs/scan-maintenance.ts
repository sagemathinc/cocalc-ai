/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { computeHostOperationalAvailability } from "@cocalc/server/conat/api/hosts-normalization";
import { runRootfsReleaseScan } from "@cocalc/server/rootfs/scan-execution";
import type { HostRootfsCacheEntry } from "@cocalc/conat/project-host/api";

const logger = getLogger("server:rootfs:scan-maintenance");

const DEFAULT_RESCAN_PERIOD_DAYS = 7;
const CHECK_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.COCALC_ROOTFS_SCAN_MAINTENANCE_INTERVAL_MS ?? 60 * 60_000),
);
const HOST_CACHE_PROBE_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.COCALC_ROOTFS_SCAN_HOST_CACHE_PROBE_TIMEOUT_MS ?? 8_000),
);
const LOCK_KEY = "rootfs_official_scan_maintenance";

type DueOfficialRootfsRelease = {
  release_id: string;
  runtime_image: string;
  image_id: string;
  label: string | null;
  scanned_at: Date | null;
};

type ScanHostCandidate = {
  host_id: string;
  name: string | null;
  cached: boolean;
};

type ProjectHostRow = {
  id: string;
  name: string | null;
  status: string | null;
  last_seen: Date | null;
  deleted: Date | null;
};

function optionalPositiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function settingsBoolean(value: unknown, defaultValue: boolean): boolean {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (!normalized) return defaultValue;
  return ["1", "true", "yes", "on"].includes(normalized);
}

function firstConfiguredValue(...values: unknown[]): unknown {
  for (const value of values) {
    const normalized = `${value ?? ""}`.trim();
    if (normalized) return value;
  }
  return undefined;
}

async function loadScanMaintenanceConfig(): Promise<{
  enabled: boolean;
  rescanPeriodDays: number;
  batchLimit: number;
}> {
  const settings = await getServerSettings();
  const scanEnabled = settingsBoolean(
    firstConfiguredValue((settings as any).rootfs_scan_enabled),
    false,
  );
  return {
    enabled:
      scanEnabled &&
      settingsBoolean(
        firstConfiguredValue(
          (settings as any).rootfs_scan_scheduled_enabled,
          process.env.COCALC_ROOTFS_SCAN_SCHEDULED_ENABLED,
        ),
        true,
      ),
    rescanPeriodDays:
      optionalPositiveInteger(
        (settings as any).rootfs_scan_rescan_period_days ??
          process.env.COCALC_ROOTFS_SCAN_RESCAN_PERIOD_DAYS,
      ) ?? DEFAULT_RESCAN_PERIOD_DAYS,
    batchLimit:
      optionalPositiveInteger(process.env.COCALC_ROOTFS_SCAN_BATCH_LIMIT) ?? 1,
  };
}

export async function listDueOfficialRootfsReleasesForScan({
  olderThanDays,
  limit,
}: {
  olderThanDays: number;
  limit: number;
}): Promise<DueOfficialRootfsRelease[]> {
  const { rows } = await getPool("medium").query<DueOfficialRootfsRelease>(
    `WITH visible_official AS (
       SELECT DISTINCT ON (rel.release_id)
              rel.release_id,
              rel.runtime_image,
              img.image_id,
              img.label,
              rel.scanned_at
         FROM rootfs_images AS img
         JOIN rootfs_releases AS rel ON rel.release_id = img.release_id
        WHERE COALESCE(img.official, false) = true
          AND COALESCE(img.hidden, false) = false
          AND COALESCE(img.deleted, false) = false
          AND img.release_id IS NOT NULL
          AND COALESCE(rel.gc_status, 'active') <> 'deleted'
          AND COALESCE(rel.scan_status, 'unknown') <> 'pending'
          AND (
            rel.scanned_at IS NULL
            OR rel.scanned_at < NOW() - make_interval(days => $1::int)
          )
        ORDER BY rel.release_id,
                 COALESCE(img.updated, img.created) DESC NULLS LAST,
                 img.image_id ASC
     )
     SELECT *
       FROM visible_official
      ORDER BY scanned_at ASC NULLS FIRST, image_id ASC
      LIMIT $2`,
    [Math.max(1, Math.floor(olderThanDays)), Math.max(1, Math.floor(limit))],
  );
  return rows;
}

async function listRunningLocalScanHosts(): Promise<ProjectHostRow[]> {
  const bayId = getConfiguredBayId();
  const { rows } = await getPool("medium").query<ProjectHostRow>(
    `SELECT id, name, status, last_seen, deleted
       FROM project_hosts
      WHERE deleted IS NULL
        AND COALESCE(bay_id, $1) = $1
      ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST`,
    [bayId],
  );
  return rows.filter(
    (row) => computeHostOperationalAvailability(row).operational,
  );
}

function hostHasRootfsImage({
  entry,
  image,
}: {
  entry: DueOfficialRootfsRelease;
  image: HostRootfsCacheEntry;
}): boolean {
  return image.image === entry.runtime_image;
}

async function hostHasCachedRootfs({
  host_id,
  entry,
}: {
  host_id: string;
  entry: DueOfficialRootfsRelease;
}): Promise<boolean> {
  const client = await getRoutedHostControlClient({
    host_id,
    timeout: HOST_CACHE_PROBE_TIMEOUT_MS,
  });
  const images = await client.listRootfsImages();
  return images.some((image) => hostHasRootfsImage({ entry, image }));
}

export async function selectHostForScheduledRootfsScan(
  entry: DueOfficialRootfsRelease,
): Promise<ScanHostCandidate | undefined> {
  const hosts = await listRunningLocalScanHosts();
  if (hosts.length === 0) {
    return undefined;
  }
  const candidates = await Promise.all(
    hosts.map(async (host): Promise<ScanHostCandidate> => {
      try {
        return {
          host_id: host.id,
          name: host.name,
          cached: await hostHasCachedRootfs({ host_id: host.id, entry }),
        };
      } catch (err) {
        logger.warn("RootFS scan host cache probe failed", {
          host_id: host.id,
          release_id: entry.release_id,
          err: `${err}`,
        });
        return {
          host_id: host.id,
          name: host.name,
          cached: false,
        };
      }
    }),
  );
  candidates.sort((a, b) => {
    if (a.cached !== b.cached) return a.cached ? -1 : 1;
    return (a.name ?? a.host_id).localeCompare(b.name ?? b.host_id);
  });
  return candidates[0];
}

async function withMaintenanceLock<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  // Advisory locks require a real PoolClient; cached pools only expose query().
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

export async function runScheduledOfficialRootfsScans(): Promise<{
  scanned: number;
  skipped_no_host: number;
  failed: number;
}> {
  const config = await loadScanMaintenanceConfig();
  if (!config.enabled) {
    return { scanned: 0, skipped_no_host: 0, failed: 0 };
  }
  const releases = await listDueOfficialRootfsReleasesForScan({
    olderThanDays: config.rescanPeriodDays,
    limit: config.batchLimit,
  });
  let scanned = 0;
  let skipped_no_host = 0;
  let failed = 0;
  for (const release of releases) {
    const host = await selectHostForScheduledRootfsScan(release);
    if (!host) {
      skipped_no_host += 1;
      logger.warn("RootFS scheduled scan skipped: no running host", {
        release_id: release.release_id,
        image_id: release.image_id,
      });
      continue;
    }
    try {
      const result = await runRootfsReleaseScan({
        release_id: release.release_id,
        host_id: host.host_id,
        requested_by: null,
      });
      if (result.status === "error") {
        failed += 1;
      } else {
        scanned += 1;
      }
      logger.info("RootFS scheduled scan completed", {
        release_id: release.release_id,
        image_id: release.image_id,
        host_id: host.host_id,
        cached: host.cached,
        status: result.status,
      });
    } catch (err) {
      failed += 1;
      logger.error("RootFS scheduled scan failed", {
        release_id: release.release_id,
        image_id: release.image_id,
        host_id: host.host_id,
        err: `${err}`,
      });
    }
  }
  return { scanned, skipped_no_host, failed };
}

let started = false;

export function startRootfsScanMaintenance(): void {
  if (started) {
    return;
  }
  started = true;
  logger.info("starting RootFS scheduled scan maintenance loop", {
    CHECK_INTERVAL_MS,
  });
  const run = async () => {
    try {
      const result = await withMaintenanceLock(runScheduledOfficialRootfsScans);
      if (!result) {
        return;
      }
      if (
        result.scanned > 0 ||
        result.skipped_no_host > 0 ||
        result.failed > 0
      ) {
        logger.info("RootFS scheduled scan maintenance completed", result);
      }
    } catch (err) {
      logger.error("RootFS scheduled scan maintenance failed", err);
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}

export const __test__ = {
  hostHasRootfsImage,
};
