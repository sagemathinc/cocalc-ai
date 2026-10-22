/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { numSubscriptions } from "@cocalc/conat/client";
import {
  getPersistentStreamDiagnostics,
  getPersistentStreamSqliteDiagnostics,
} from "@cocalc/conat/persist/storage";
import type { PersistStreamReleaseQueueDiagnostics } from "@cocalc/conat/persist/release-queue";
import type { PersistFenceDiagnostic } from "@cocalc/conat/persist/fence";
import { performance } from "node:perf_hooks";
import {
  getHeapCodeStatistics,
  getHeapSpaceStatistics,
  getHeapStatistics,
} from "node:v8";

export const PROJECT_HOST_PERSIST_DIAGNOSTICS_PATH = "/diagnostics";

function countActiveResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo?.() ?? []) {
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function isLoopbackRemoteAddress(address?: string): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function collectProjectHostPersistDiagnostics({
  includePersistenceDetail = false,
  fences,
  maintenance,
  ready = true,
  serverId,
  streamReleases,
}: {
  includePersistenceDetail?: boolean;
  // the projects whose streams are fenced (conat/persist/fence.ts)
  fences?: PersistFenceDiagnostic[];
  maintenance?: {
    enabled: boolean;
    dryRun: boolean;
    catalogHealthy: boolean;
    trackingCoverage: boolean;
    openPaths: number;
    presentDatabases: number;
    missingDatabases: number;
    unverifiedDatabases: number;
    presentFileBytes: number;
    presentWalBytes: number;
    lastScanStartedAt?: number;
    lastScanCompletedAt?: number;
    scannedFiles: number;
    pauseReason?: string;
    lastError?: string;
  };
  ready?: boolean;
  serverId?: string;
  streamReleases?: PersistStreamReleaseQueueDiagnostics;
} = {}) {
  const persistence = getPersistentStreamDiagnostics();
  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    ready,
    server_id: serverId ?? null,
    process: {
      pid: process.pid,
      node_version: process.version,
      uptime_seconds: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      resource_usage: process.resourceUsage(),
      active_resources: countActiveResources(),
      event_loop_utilization: performance.eventLoopUtilization(),
    },
    v8: {
      heap: getHeapStatistics(),
      heap_spaces: getHeapSpaceStatistics(),
      heap_code: getHeapCodeStatistics(),
    },
    conat: {
      local_client_subscriptions: numSubscriptions(),
      persistence: {
        local_open_streams: persistence.open_total,
        local_streams: persistence,
        ...(streamReleases ? { deferred_releases: streamReleases } : {}),
        ...(fences ? { fences } : {}),
        ...(maintenance
          ? {
              maintenance: {
                enabled: maintenance.enabled,
                dry_run: maintenance.dryRun,
                catalog_healthy: maintenance.catalogHealthy,
                tracking_coverage: maintenance.trackingCoverage,
                open_paths: maintenance.openPaths,
                present_databases: maintenance.presentDatabases,
                missing_databases: maintenance.missingDatabases,
                unverified_databases: maintenance.unverifiedDatabases,
                present_file_bytes: maintenance.presentFileBytes,
                present_wal_bytes: maintenance.presentWalBytes,
                last_scan_started_at_ms: maintenance.lastScanStartedAt,
                last_scan_completed_at_ms: maintenance.lastScanCompletedAt,
                scanned_files: maintenance.scannedFiles,
                pause_reason: maintenance.pauseReason,
                last_error: maintenance.lastError,
              },
            }
          : {}),
        ...(includePersistenceDetail
          ? { sqlite_detail: getPersistentStreamSqliteDiagnostics() }
          : {}),
      },
    },
  };
}
