/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import getPool from "@cocalc/database/pool";
import { appendRootfsImageEventForReleaseImages } from "@cocalc/server/rootfs/events";
import type {
  RootfsScanReportRef,
  RootfsScanStatus,
  RootfsScanSummary,
} from "@cocalc/util/rootfs-images";
import type {
  RootfsReleaseScanRun,
  RootfsReleaseScanRunStatus,
} from "@cocalc/util/rootfs-scan";
import { v4 as uuid } from "uuid";

export type RootfsReleaseForScan = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  arch?: string;
  size_bytes?: number;
};

type RootfsReleaseScanRow = {
  release_id: string;
  content_key: string;
  runtime_image: string;
  arch: string | null;
  size_bytes: number | null;
};

type RootfsReleaseScanRunRow = {
  scan_run_id: string;
  release_id: string;
  content_key: string;
  runtime_image: string;
  requested_by: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  bay_id: string | null;
  host_id: string | null;
  tool: string | null;
  tool_version: string | null;
  db_version: string | null;
  db_updated_at: Date | null;
  status: RootfsReleaseScanRunStatus;
  severity_counts: RootfsScanSummary["severity_counts"] | null;
  summary: RootfsScanSummary | null;
  report_artifact: RootfsScanReportRef | null;
  report_bytes: number | null;
  report_compressed_bytes: number | null;
  report_sha256: string | null;
  report_retention_until: Date | null;
  error: string | null;
  error_code: string | null;
};

function rowToRelease(row: RootfsReleaseScanRow): RootfsReleaseForScan {
  return {
    release_id: row.release_id,
    content_key: row.content_key,
    runtime_image: row.runtime_image,
    arch: row.arch ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
  };
}

function rowToScanRun(row: RootfsReleaseScanRunRow): RootfsReleaseScanRun {
  return {
    scan_run_id: row.scan_run_id,
    release_id: row.release_id,
    content_key: row.content_key,
    runtime_image: row.runtime_image,
    requested_by: row.requested_by ?? undefined,
    requested_at: row.requested_at.toISOString(),
    started_at: row.started_at?.toISOString(),
    completed_at: row.completed_at?.toISOString(),
    bay_id: row.bay_id ?? undefined,
    host_id: row.host_id ?? undefined,
    tool: row.tool ?? undefined,
    tool_version: row.tool_version ?? undefined,
    db_version: row.db_version ?? undefined,
    db_updated_at: row.db_updated_at?.toISOString(),
    status: row.status,
    severity_counts: row.severity_counts ?? undefined,
    summary: row.summary ?? undefined,
    report_artifact: row.report_artifact ?? undefined,
    report_bytes: row.report_bytes ?? undefined,
    report_compressed_bytes: row.report_compressed_bytes ?? undefined,
    report_sha256: row.report_sha256 ?? undefined,
    report_retention_until: row.report_retention_until?.toISOString(),
    error: row.error ?? undefined,
    error_code: row.error_code ?? undefined,
  };
}

function compactError(err: unknown): string {
  const message = err instanceof Error ? err.message : `${err}`;
  return message.length > 4000 ? `${message.slice(0, 4000)}...` : message;
}

export async function loadRootfsReleaseForScan({
  release_id,
}: {
  release_id: string;
}): Promise<RootfsReleaseForScan | undefined> {
  const { rows } = await getPool("medium").query<RootfsReleaseScanRow>(
    `SELECT
       release_id,
       content_key,
       runtime_image,
       arch,
       size_bytes
     FROM rootfs_releases
     WHERE release_id=$1
       AND COALESCE(gc_status, 'active') <> 'deleted'`,
    [release_id],
  );
  return rows[0] ? rowToRelease(rows[0]) : undefined;
}

export async function createRootfsReleaseScanRun({
  release_id,
  requested_by,
}: {
  release_id: string;
  requested_by?: string | null;
}): Promise<RootfsReleaseScanRun> {
  const release = await loadRootfsReleaseForScan({ release_id });
  if (!release) {
    throw new Error(`RootFS release ${release_id} not found`);
  }
  const scan_run_id = uuid();
  const bay_id = getConfiguredBayId();
  const { rows } = await getPool("medium").query<RootfsReleaseScanRunRow>(
    `INSERT INTO rootfs_release_scan_runs
       (
         scan_run_id,
         release_id,
         content_key,
         runtime_image,
         requested_by,
         requested_at,
         bay_id,
         tool,
         status,
         created_at,
         updated_at
       )
     VALUES
       ($1, $2, $3, $4, $5, NOW(), $6, 'trivy', 'pending', NOW(), NOW())
     RETURNING *`,
    [
      scan_run_id,
      release.release_id,
      release.content_key,
      release.runtime_image,
      requested_by ?? null,
      bay_id,
    ],
  );
  await getPool("medium").query(
    `UPDATE rootfs_releases
     SET scan_status='pending',
         scan_tool='trivy',
         updated=NOW()
     WHERE release_id=$1`,
    [release.release_id],
  );
  await appendRootfsImageEventForReleaseImages({
    release_id: release.release_id,
    event_type: "scan_requested",
    actor_account_id: requested_by ?? null,
    payload: { scan_run_id, tool: "trivy" },
  });
  return rowToScanRun(rows[0]);
}

export async function markRootfsReleaseScanRunStarted({
  scan_run_id,
  host_id,
}: {
  scan_run_id: string;
  host_id?: string | null;
}): Promise<RootfsReleaseScanRun> {
  const { rows } = await getPool("medium").query<RootfsReleaseScanRunRow>(
    `UPDATE rootfs_release_scan_runs
     SET status='running',
         host_id=$2,
         started_at=NOW(),
         updated_at=NOW()
     WHERE scan_run_id=$1
     RETURNING *`,
    [scan_run_id, host_id ?? null],
  );
  if (!rows[0]) {
    throw new Error(`RootFS scan run ${scan_run_id} not found`);
  }
  await getPool("medium").query(
    `UPDATE rootfs_releases
     SET scan_status='pending',
         scan_tool='trivy',
         updated=NOW()
     WHERE release_id=$1`,
    [rows[0].release_id],
  );
  await appendRootfsImageEventForReleaseImages({
    release_id: rows[0].release_id,
    event_type: "scan_started",
    payload: { scan_run_id, host_id: host_id ?? null },
  });
  return rowToScanRun(rows[0]);
}

export async function completeRootfsReleaseScanRun({
  scan_run_id,
  summary,
  host_id,
  report_retention_until,
}: {
  scan_run_id: string;
  summary: RootfsScanSummary;
  host_id?: string | null;
  report_retention_until?: Date | null;
}): Promise<RootfsReleaseScanRun> {
  const status: Extract<RootfsReleaseScanRunStatus, "clean" | "findings"> =
    summary.status === "clean" ? "clean" : "findings";
  const dbUpdatedAt = summary.db?.updated_at
    ? new Date(summary.db.updated_at)
    : null;
  const { rows } = await getPool("medium").query<RootfsReleaseScanRunRow>(
    `UPDATE rootfs_release_scan_runs
     SET status=$2,
         host_id=COALESCE($3, host_id),
         tool=COALESCE($4, tool),
         tool_version=$5,
         db_version=$6,
         db_updated_at=$7,
         completed_at=NOW(),
         severity_counts=$8::JSONB,
         summary=$9::JSONB,
         report_artifact=$10::JSONB,
         report_bytes=$11,
         report_compressed_bytes=$12,
         report_sha256=$13,
         report_retention_until=$14,
         error=NULL,
         error_code=NULL,
         updated_at=NOW()
     WHERE scan_run_id=$1
     RETURNING *`,
    [
      scan_run_id,
      status,
      host_id ?? null,
      summary.tool ?? "trivy",
      summary.tool_version ?? summary.scanner_version ?? null,
      summary.db?.version ?? null,
      dbUpdatedAt,
      JSON.stringify(summary.severity_counts ?? summary.findings_summary ?? {}),
      JSON.stringify(summary),
      summary.report ? JSON.stringify(summary.report) : null,
      summary.report?.bytes ?? null,
      summary.report?.compressed_bytes ?? null,
      summary.report?.sha256 ?? null,
      report_retention_until ?? null,
    ],
  );
  if (!rows[0]) {
    throw new Error(`RootFS scan run ${scan_run_id} not found`);
  }
  await getPool("medium").query(
    `UPDATE rootfs_releases
     SET scan_status=$2,
         scan_tool=COALESCE($3, scan_tool),
         scanned_at=NOW(),
         scan_summary=$4::JSONB,
         updated=NOW()
     WHERE release_id=$1`,
    [
      rows[0].release_id,
      summary.status as RootfsScanStatus,
      summary.tool ?? "trivy",
      JSON.stringify(summary),
    ],
  );
  await appendRootfsImageEventForReleaseImages({
    release_id: rows[0].release_id,
    event_type: "scan_completed",
    payload: {
      scan_run_id,
      status,
      severity_counts: summary.severity_counts ?? summary.findings_summary,
      report: summary.report,
    },
  });
  return rowToScanRun(rows[0]);
}

export async function failRootfsReleaseScanRun({
  scan_run_id,
  err,
  error_code,
  host_id,
}: {
  scan_run_id: string;
  err: unknown;
  error_code?: string;
  host_id?: string | null;
}): Promise<RootfsReleaseScanRun> {
  const error = compactError(err);
  const summary: RootfsScanSummary = {
    status: "error",
    tool: "trivy",
    scanned_at: new Date().toISOString(),
    error: {
      message: error,
      code: error_code,
    },
  };
  const { rows } = await getPool("medium").query<RootfsReleaseScanRunRow>(
    `UPDATE rootfs_release_scan_runs
     SET status='error',
         host_id=COALESCE($2, host_id),
         completed_at=NOW(),
         summary=$3::JSONB,
         error=$4,
         error_code=$5,
         updated_at=NOW()
     WHERE scan_run_id=$1
     RETURNING *`,
    [
      scan_run_id,
      host_id ?? null,
      JSON.stringify(summary),
      error,
      error_code ?? null,
    ],
  );
  if (!rows[0]) {
    throw new Error(`RootFS scan run ${scan_run_id} not found`);
  }
  await getPool("medium").query(
    `UPDATE rootfs_releases
     SET scan_status='error',
         scan_tool='trivy',
         scanned_at=NOW(),
         scan_summary=$2::JSONB,
         updated=NOW()
     WHERE release_id=$1`,
    [rows[0].release_id, JSON.stringify(summary)],
  );
  await appendRootfsImageEventForReleaseImages({
    release_id: rows[0].release_id,
    event_type: "scan_failed",
    payload: { scan_run_id, error, error_code },
  });
  return rowToScanRun(rows[0]);
}
