/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";

import getLogger from "@cocalc/backend/logger";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { getAssignedProjectHostInfo } from "@cocalc/server/conat/project-host-assignment";
import {
  completeRootfsReleaseScanRun,
  createRootfsReleaseScanRun,
  failRootfsReleaseScanRun,
  loadRootfsReleaseForScan,
  markRootfsReleaseScanRunStarted,
  storeRootfsReleaseScanReport,
} from "@cocalc/server/rootfs/scans";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import { getProjectRootfsStates } from "@cocalc/server/projects/rootfs-state";
import {
  DEFAULT_TRIVY_CACHE_DIR,
  DEFAULT_TRIVY_SCANNER_IMAGE,
  type RootfsProjectPreflightScanResult,
  type RootfsReleaseScanRun,
} from "@cocalc/util/rootfs-scan";

const logger = getLogger("server:rootfs:scan-execution");

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

function settingsBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = `${value}`.trim().toLowerCase();
  if (["true", "yes", "1", "on"].includes(normalized)) return true;
  if (["false", "no", "0", "off"].includes(normalized)) return false;
  return fallback;
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
  if (!settingsBoolean((settings as any).rootfs_scan_enabled, false)) {
    throw new Error(
      "RootFS vulnerability scanning is disabled for this site; enable rootfs_scan_enabled in site settings first.",
    );
  }
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
  return await executeRootfsReleaseScanRun({
    run,
    host_id,
    requested_by,
    scanner_image: config.scanner_image,
    trivy_cache_dir: config.trivy_cache_dir,
    timeout_ms,
    max_target_bytes,
    max_report_bytes,
    memory_limit,
    cpu_limit,
    tmpfs_size,
    retention_days: config.retention_days,
  });
}

export async function queueRootfsReleaseScan({
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
  void executeRootfsReleaseScanRun({
    run,
    host_id,
    requested_by,
    scanner_image: config.scanner_image,
    trivy_cache_dir: config.trivy_cache_dir,
    timeout_ms,
    max_target_bytes,
    max_report_bytes,
    memory_limit,
    cpu_limit,
    tmpfs_size,
    retention_days: config.retention_days,
  }).catch((err) => {
    logger.error("background RootFS release scan failed", {
      scan_run_id: run.scan_run_id,
      release_id,
      host_id,
      err: `${err}`,
    });
  });
  return run;
}

async function executeRootfsReleaseScanRun({
  run,
  host_id,
  requested_by,
  scanner_image,
  trivy_cache_dir,
  timeout_ms,
  max_target_bytes,
  max_report_bytes,
  memory_limit,
  cpu_limit,
  tmpfs_size,
  retention_days,
}: {
  run: RootfsReleaseScanRun;
  host_id: string;
  requested_by?: string | null;
  scanner_image: string;
  trivy_cache_dir: string;
  timeout_ms: number;
  max_target_bytes?: number;
  max_report_bytes: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
  retention_days: number;
}): Promise<RootfsReleaseScanRun> {
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
      target: {
        target_kind: "rootfs-release",
        release_id: run.release_id,
        content_key: run.content_key,
        runtime_image: run.runtime_image,
      },
      scanner_image,
      trivy_cache_dir,
      timeout_ms,
      max_target_bytes,
      max_report_bytes,
      memory_limit,
      cpu_limit,
      tmpfs_size,
    });
    const retention = new Date(
      Date.now() + retention_days * 24 * 60 * 60 * 1000,
    );
    const reportArtifact =
      result.report_json != null
        ? await storeRootfsReleaseScanReport({
            scan_run_id: run.scan_run_id,
            release_id: run.release_id,
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

export async function runProjectRootfsPreflightScan({
  project_id,
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
  project_id: string;
  requested_by?: string | null;
  scanner_image?: string;
  trivy_cache_dir?: string;
  timeout_ms?: number;
  max_target_bytes?: number;
  max_report_bytes?: number;
  memory_limit?: string;
  cpu_limit?: string;
  tmpfs_size?: string;
}): Promise<RootfsProjectPreflightScanResult> {
  const config = await getRootfsScanConfig({ scanner_image, trivy_cache_dir });
  const timeout_ms = timeoutMsOverride ?? config.timeout_ms;
  const max_target_bytes = maxTargetBytesOverride ?? config.max_target_bytes;
  const max_report_bytes = maxReportBytesOverride ?? config.max_report_bytes;
  const host = await getAssignedProjectHostInfo(project_id);
  const states = await getProjectRootfsStates({ project_id });
  const current = states.find((state) => state.state_role === "current");
  const scan_run_id = randomUUID();
  const client = await getRoutedHostControlClient({
    host_id: host.host_id,
    timeout: timeout_ms,
    account_id: requested_by ?? undefined,
  });
  const result = await client.scanProjectRootfs({
    project_id,
    scan_run_id,
    target: {
      target_kind: "project-rootfs",
      project_id,
      release_id: current?.release_id,
      content_key: current?.release_id ?? project_id,
      runtime_image: current?.image ?? "project-rootfs",
    },
    scanner_image: config.scanner_image,
    trivy_cache_dir: config.trivy_cache_dir,
    timeout_ms,
    max_target_bytes,
    max_report_bytes,
    memory_limit,
    cpu_limit,
    tmpfs_size,
  });
  return {
    project_id,
    host_id: host.host_id,
    summary: {
      ...result.summary,
      metadata: {
        ...(result.summary.metadata ?? {}),
        scan_run_id,
        target_kind: "project-rootfs",
        host_id: host.host_id,
        requested_by: requested_by ?? undefined,
        preflight_only: true,
      },
    },
    duration_ms: result.duration_ms,
    report: result.report,
  };
}
