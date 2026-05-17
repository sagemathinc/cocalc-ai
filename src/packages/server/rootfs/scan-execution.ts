/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getServerSettings } from "@cocalc/database/settings/server-settings";
import {
  completeRootfsReleaseScanRun,
  createRootfsReleaseScanRun,
  failRootfsReleaseScanRun,
  loadRootfsReleaseForScan,
  markRootfsReleaseScanRunStarted,
  storeRootfsReleaseScanReport,
} from "@cocalc/server/rootfs/scans";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  DEFAULT_TRIVY_CACHE_DIR,
  DEFAULT_TRIVY_SCANNER_IMAGE,
  type RootfsReleaseScanRun,
} from "@cocalc/util/rootfs-scan";

function optionalPositiveInteger(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const trimmed = `${value ?? ""}`.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

export async function getRootfsScanConfig({
  scanner_image,
  trivy_cache_dir,
}: {
  scanner_image?: string;
  trivy_cache_dir?: string;
}): Promise<{
  scanner_image: string;
  trivy_cache_dir: string;
  timeout_ms: number;
  max_target_bytes?: number;
  max_report_bytes: number;
  retention_days: number;
}> {
  const settings = await getServerSettings();
  const image = firstNonEmptyString(
    scanner_image,
    (settings as any).rootfs_scan_container_image,
    process.env.COCALC_ROOTFS_SCAN_TRIVY_IMAGE,
    DEFAULT_TRIVY_SCANNER_IMAGE,
  );
  const cache = firstNonEmptyString(
    trivy_cache_dir,
    (settings as any).rootfs_scan_trivy_cache_dir,
    process.env.COCALC_ROOTFS_SCAN_TRIVY_CACHE_DIR,
    DEFAULT_TRIVY_CACHE_DIR,
  );
  if (!image) {
    throw new Error(
      "RootFS scan scanner image is not configured; set rootfs_scan_container_image, COCALC_ROOTFS_SCAN_TRIVY_IMAGE, or pass scanner_image",
    );
  }
  if (!cache) {
    throw new Error(
      "RootFS scan Trivy cache directory is not configured; set rootfs_scan_trivy_cache_dir, COCALC_ROOTFS_SCAN_TRIVY_CACHE_DIR, or pass trivy_cache_dir",
    );
  }
  const timeoutMinutes =
    optionalPositiveInteger((settings as any).rootfs_scan_timeout_minutes) ??
    30;
  const maxTargetGb = optionalPositiveInteger(
    (settings as any).rootfs_scan_max_target_gb,
  );
  const maxReportMb =
    optionalPositiveInteger((settings as any).rootfs_scan_max_report_mb) ?? 64;
  const retentionDays =
    optionalPositiveInteger(
      (settings as any).rootfs_scan_full_report_retention_days,
    ) ?? 730;
  return {
    scanner_image: image,
    trivy_cache_dir: cache,
    timeout_ms: timeoutMinutes * 60 * 1000,
    max_target_bytes:
      maxTargetGb == null ? undefined : maxTargetGb * 1_000_000_000,
    max_report_bytes: maxReportMb * 1024 * 1024,
    retention_days: retentionDays,
  };
}

export async function runRootfsReleaseScan({
  release_id,
  host_id,
  requested_by,
  scanner_image,
  trivy_cache_dir,
  timeout_ms: timeoutMsOverride,
  max_target_bytes: maxTargetBytesOverride,
  max_report_bytes: maxReportBytesOverride,
  memory_limit,
  cpu_limit,
  tmpfs_size,
}: {
  release_id: string;
  host_id: string;
  requested_by?: string | null;
  scanner_image?: string;
  trivy_cache_dir?: string;
  timeout_ms?: number;
  max_target_bytes?: number;
  max_report_bytes?: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
}): Promise<RootfsReleaseScanRun> {
  const config = await getRootfsScanConfig({ scanner_image, trivy_cache_dir });
  const timeout_ms = timeoutMsOverride ?? config.timeout_ms;
  const max_target_bytes = maxTargetBytesOverride ?? config.max_target_bytes;
  const max_report_bytes = maxReportBytesOverride ?? config.max_report_bytes;
  const release = await loadRootfsReleaseForScan({ release_id });
  if (!release) {
    throw new Error(`RootFS release ${release_id} not found`);
  }
  const run = await createRootfsReleaseScanRun({
    release_id,
    requested_by,
  });
  try {
    await markRootfsReleaseScanRunStarted({
      scan_run_id: run.scan_run_id,
      host_id,
    });
    const client = await getRoutedHostControlClient({
      host_id,
      timeout: timeout_ms,
      fresh: true,
      account_id: requested_by ?? undefined,
    });
    const result = await client.scanRootfsRelease({
      scan_run_id: run.scan_run_id,
      target: release,
      scanner_image: config.scanner_image,
      trivy_cache_dir: config.trivy_cache_dir,
      timeout_ms,
      max_target_bytes,
      max_report_bytes,
      memory_limit,
      cpu_limit,
      tmpfs_size,
    });
    const retention = new Date(
      Date.now() + config.retention_days * 24 * 60 * 60 * 1000,
    );
    const reportArtifact =
      result.report_json != null
        ? await storeRootfsReleaseScanReport({
            scan_run_id: run.scan_run_id,
            release_id,
            report_json: result.report_json,
            report: result.report,
            retention_until: retention,
          })
        : undefined;
    const summary = {
      ...result.summary,
      report: {
        ...(result.summary.report ?? {}),
        ...(reportArtifact ?? {}),
        ...result.report,
        format: "trivy-json",
        retention_until: retention.toISOString(),
      },
    };
    return await completeRootfsReleaseScanRun({
      scan_run_id: run.scan_run_id,
      summary,
      host_id,
      report_retention_until: retention,
    });
  } catch (err) {
    return await failRootfsReleaseScanRun({
      scan_run_id: run.scan_run_id,
      err,
      error_code: "scan_execution_failed",
      host_id,
    });
  }
}
