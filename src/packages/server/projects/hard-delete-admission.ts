/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ConatError } from "@cocalc/conat/core/client";
import getPool from "@cocalc/database/pool";
import { ensureLroSchema } from "@cocalc/server/lro/lro-db";

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
  account_recent: number;
  global_inflight: number;
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

function deny({
  code,
  message,
}: {
  code: ProjectHardDeleteAdmissionLimitCode;
  message: string;
}): never {
  throw new ConatError(message, { code });
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
            AND status = ANY($3::text[])
        )::int AS account_inflight,
        COUNT(*) FILTER (
          WHERE created_by=$1
            AND created_at >= now() - ($2::int * interval '1 second')
        )::int AS account_recent,
        COUNT(*) FILTER (
          WHERE status = ANY($3::text[])
        )::int AS global_inflight,
        COUNT(*) FILTER (
          WHERE dedupe_key=$4
            AND status <> ALL($5::text[])
        )::int AS same_project_active
      FROM long_running_operations
      WHERE kind='project-hard-delete'
    `,
    [
      account_id,
      recent_window_seconds,
      ["queued", "running"],
      `project-hard-delete:${project_id}`,
      ["succeeded", "failed", "canceled", "expired"],
    ],
  );
  const row = rows[0] ?? {};
  return {
    account_inflight: asInteger(row.account_inflight),
    account_recent: asInteger(row.account_recent),
    global_inflight: asInteger(row.global_inflight),
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
  if (counts.account_inflight >= limits.account_inflight) {
    deny({
      code: "project_delete_rate_limited_account_inflight",
      message:
        "Too many project deletes are already queued or running for this account.",
    });
  }
  if (counts.account_recent >= limits.account_recent) {
    deny({
      code: "project_delete_rate_limited_account_recent",
      message: "Too many projects were deleted by this account recently.",
    });
  }
  if (counts.global_inflight >= limits.global_inflight) {
    deny({
      code: "project_delete_rate_limited_global_inflight",
      message:
        "Too many project deletes are already queued or running. Try again later.",
    });
  }
  return counts;
}
