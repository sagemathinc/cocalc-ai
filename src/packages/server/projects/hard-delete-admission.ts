/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ConatError } from "@cocalc/conat/core/client";
import getPool from "@cocalc/database/pool";
import { ensureLroSchema } from "@cocalc/server/lro/lro-db";

const ACTIVE_STATUSES = ["queued", "running"] as const;
const TERMINAL_STATUSES = ["succeeded", "failed", "canceled", "expired"];
const DEFAULT_RUNNING_LEASE_MS = 120_000;

export type ProjectHardDeleteAdmissionLimitCode =
  | "project_delete_rate_limited_account_inflight"
  | "project_delete_rate_limited_account_recent"
  | "project_delete_rate_limited_global_inflight";

export interface ProjectHardDeleteAdmissionLimits {
  account_inflight: number;
  account_recent: number;
  account_recent_window_seconds: number;
  global_inflight: number;
}

export interface ProjectHardDeleteAdmissionCounts {
  account_inflight: number;
  account_queued: number;
  account_running: number;
  account_recent: number;
  global_inflight: number;
  global_queued: number;
  global_running: number;
  same_project_active: number;
}

export const DEFAULT_PROJECT_HARD_DELETE_ADMISSION_LIMITS: ProjectHardDeleteAdmissionLimits =
  {
    account_inflight: 2,
    account_recent: 10,
    account_recent_window_seconds: 60 * 60,
    global_inflight: 100,
  };

function envInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? "");
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

export function getProjectHardDeleteAdmissionLimits(): ProjectHardDeleteAdmissionLimits {
  return {
    account_inflight: envInteger(
      "COCALC_PROJECT_HARD_DELETE_ACCOUNT_INFLIGHT_LIMIT",
      DEFAULT_PROJECT_HARD_DELETE_ADMISSION_LIMITS.account_inflight,
    ),
    account_recent: envInteger(
      "COCALC_PROJECT_HARD_DELETE_ACCOUNT_RECENT_LIMIT",
      DEFAULT_PROJECT_HARD_DELETE_ADMISSION_LIMITS.account_recent,
    ),
    account_recent_window_seconds: envInteger(
      "COCALC_PROJECT_HARD_DELETE_ACCOUNT_RECENT_WINDOW_SECONDS",
      DEFAULT_PROJECT_HARD_DELETE_ADMISSION_LIMITS.account_recent_window_seconds,
    ),
    global_inflight: envInteger(
      "COCALC_PROJECT_HARD_DELETE_GLOBAL_INFLIGHT_LIMIT",
      DEFAULT_PROJECT_HARD_DELETE_ADMISSION_LIMITS.global_inflight,
    ),
  };
}

function asInteger(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function limitReached(count: number, limit: number): boolean {
  return limit > 0 && count >= limit;
}

function deny({
  code,
  message,
}: {
  code: ProjectHardDeleteAdmissionLimitCode;
  message: string;
}): never {
  throw new ConatError(message, { code });
}

function accountInflightMessage({
  counts,
  limits,
}: {
  counts: ProjectHardDeleteAdmissionCounts;
  limits: ProjectHardDeleteAdmissionLimits;
}): string {
  return (
    "Too many project deletes are already queued or running for this account " +
    `(queued=${counts.account_queued}, running=${counts.account_running}, ` +
    `total=${counts.account_inflight}, limit=${limits.account_inflight}).`
  );
}

function accountRecentMessage({
  counts,
  limits,
}: {
  counts: ProjectHardDeleteAdmissionCounts;
  limits: ProjectHardDeleteAdmissionLimits;
}): string {
  return (
    "Too many projects were deleted by this account recently " +
    `(recent=${counts.account_recent}, limit=${limits.account_recent}, ` +
    `window_seconds=${limits.account_recent_window_seconds}).`
  );
}

function globalInflightMessage({
  counts,
  limits,
}: {
  counts: ProjectHardDeleteAdmissionCounts;
  limits: ProjectHardDeleteAdmissionLimits;
}): string {
  return (
    "Too many project deletes are already queued or running globally " +
    `(queued=${counts.global_queued}, running=${counts.global_running}, ` +
    `total=${counts.global_inflight}, limit=${limits.global_inflight}). ` +
    "Try again later."
  );
}

export async function getProjectHardDeleteAdmissionCounts({
  account_id,
  project_id,
  recent_window_seconds,
}: {
  account_id: string;
  project_id: string;
  recent_window_seconds: number;
}): Promise<ProjectHardDeleteAdmissionCounts> {
  await ensureLroSchema();
  const { rows } = await getPool().query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE created_by=$1
            AND expires_at > now()
            AND status = ANY($3::text[])
            AND (
              status='queued'
              OR (
                status='running'
                AND heartbeat_at IS NOT NULL
                AND heartbeat_at >= now() - ($6::text || ' milliseconds')::interval
              )
            )
        )::int AS account_inflight,
        COUNT(*) FILTER (
          WHERE created_by=$1
            AND expires_at > now()
            AND status='queued'
        )::int AS account_queued,
        COUNT(*) FILTER (
          WHERE created_by=$1
            AND expires_at > now()
            AND status='running'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at >= now() - ($6::text || ' milliseconds')::interval
        )::int AS account_running,
        COUNT(*) FILTER (
          WHERE created_by=$1
            AND created_at >= now() - ($2::int * interval '1 second')
            AND status <> 'expired'
        )::int AS account_recent,
        COUNT(*) FILTER (
          WHERE expires_at > now()
            AND status = ANY($3::text[])
            AND (
              status='queued'
              OR (
                status='running'
                AND heartbeat_at IS NOT NULL
                AND heartbeat_at >= now() - ($6::text || ' milliseconds')::interval
              )
            )
        )::int AS global_inflight,
        COUNT(*) FILTER (
          WHERE expires_at > now()
            AND status='queued'
        )::int AS global_queued,
        COUNT(*) FILTER (
          WHERE expires_at > now()
            AND status='running'
            AND heartbeat_at IS NOT NULL
            AND heartbeat_at >= now() - ($6::text || ' milliseconds')::interval
        )::int AS global_running,
        COUNT(*) FILTER (
          WHERE dedupe_key=$4
            AND expires_at > now()
            AND status <> ALL($5::text[])
        )::int AS same_project_active
      FROM long_running_operations
      WHERE kind='project-hard-delete'
    `,
    [
      account_id,
      recent_window_seconds,
      ACTIVE_STATUSES,
      `project-hard-delete:${project_id}`,
      TERMINAL_STATUSES,
      DEFAULT_RUNNING_LEASE_MS,
    ],
  );
  const row = rows[0] ?? {};
  return {
    account_inflight: asInteger(row.account_inflight),
    account_queued: asInteger(row.account_queued),
    account_running: asInteger(row.account_running),
    account_recent: asInteger(row.account_recent),
    global_inflight: asInteger(row.global_inflight),
    global_queued: asInteger(row.global_queued),
    global_running: asInteger(row.global_running),
    same_project_active: asInteger(row.same_project_active),
  };
}

export async function assertProjectHardDeleteAdmission({
  account_id,
  project_id,
  limits = getProjectHardDeleteAdmissionLimits(),
}: {
  account_id: string;
  project_id: string;
  limits?: ProjectHardDeleteAdmissionLimits;
}): Promise<ProjectHardDeleteAdmissionCounts> {
  const counts = await getProjectHardDeleteAdmissionCounts({
    account_id,
    project_id,
    recent_window_seconds: limits.account_recent_window_seconds,
  });
  if (counts.same_project_active > 0) {
    return counts;
  }
  if (limitReached(counts.account_inflight, limits.account_inflight)) {
    deny({
      code: "project_delete_rate_limited_account_inflight",
      message: accountInflightMessage({ counts, limits }),
    });
  }
  if (limitReached(counts.account_recent, limits.account_recent)) {
    deny({
      code: "project_delete_rate_limited_account_recent",
      message: accountRecentMessage({ counts, limits }),
    });
  }
  if (limitReached(counts.global_inflight, limits.global_inflight)) {
    deny({
      code: "project_delete_rate_limited_global_inflight",
      message: globalInflightMessage({ counts, limits }),
    });
  }
  return counts;
}
