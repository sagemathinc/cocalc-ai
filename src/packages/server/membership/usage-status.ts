/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import {
  getStorageOverview,
  type ProjectStorageOverview,
} from "@cocalc/conat/project/storage-info";
import type {
  MembershipResolution,
  MembershipUsageStatus,
} from "@cocalc/conat/hub/api/purchases";
import { conatWithProjectRoutingForAccount } from "@cocalc/server/conat/route-client";

const log = getLogger("server:membership:usage-status");

const STORAGE_SAMPLE_CONCURRENCY = 8;
const STORAGE_SAMPLE_TIMEOUT_MS = 5_000;

type OwnedProjectRow = {
  project_id: string;
  host_id: string | null;
  provisioned: boolean | null;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function extractQuotaUsedBytes(overview: ProjectStorageOverview): number {
  const quota = overview.quotas.find((entry) => entry.key === "project");
  return typeof quota?.used === "number" && Number.isFinite(quota.used)
    ? quota.used
    : 0;
}

async function listOwnedProjects(
  account_id: string,
): Promise<OwnedProjectRow[]> {
  const { rows } = await getPool("medium").query<OwnedProjectRow>(
    `
      SELECT project_id, host_id, provisioned
      FROM projects
      WHERE deleted IS NULL
        AND COALESCE(users -> $1::text ->> 'group', '') = 'owner'
      ORDER BY project_id
    `,
    [account_id],
  );
  return rows;
}

async function sampleProjectStorageBytes({
  project_id,
  client,
}: {
  project_id: string;
  client: ReturnType<typeof conatWithProjectRoutingForAccount>;
}): Promise<number> {
  const overview = await withTimeout(
    getStorageOverview({
      client,
      project_id,
    }),
    STORAGE_SAMPLE_TIMEOUT_MS,
  );
  return extractQuotaUsedBytes(overview);
}

export async function getMembershipUsageStatusForAccount({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution: MembershipResolution;
}): Promise<MembershipUsageStatus> {
  const usageLimits = resolution.entitlements?.usage_limits ?? {};
  const ownedProjects = await listOwnedProjects(account_id);
  const provisionedRows = ownedProjects.filter(
    (row) => !!row.host_id && row.provisioned !== false,
  );
  const client = conatWithProjectRoutingForAccount({ account_id });
  let total_storage_bytes = 0;
  let sampled_project_count = 0;
  let measurement_error_count = 0;
  try {
    for (
      let start = 0;
      start < provisionedRows.length;
      start += STORAGE_SAMPLE_CONCURRENCY
    ) {
      const chunk = provisionedRows.slice(
        start,
        start + STORAGE_SAMPLE_CONCURRENCY,
      );
      const settled = await Promise.allSettled(
        chunk.map(async ({ project_id }) => {
          const used = await sampleProjectStorageBytes({
            project_id,
            client,
          });
          return { project_id, used };
        }),
      );
      for (const result of settled) {
        if (result.status === "fulfilled") {
          total_storage_bytes += result.value.used;
          sampled_project_count += 1;
        } else {
          measurement_error_count += 1;
          log.debug("unable to sample owned project storage", {
            account_id,
            err: `${result.reason ?? ""}`,
          });
        }
      }
    }
  } finally {
    try {
      client.close();
    } catch {
      // ignore close errors
    }
  }

  const owned_project_count = ownedProjects.length;
  const unsampled_project_count = Math.max(
    provisionedRows.length - sampled_project_count,
    0,
  );
  const total_storage_soft_bytes =
    typeof usageLimits.total_storage_soft_bytes === "number" &&
    Number.isFinite(usageLimits.total_storage_soft_bytes)
      ? usageLimits.total_storage_soft_bytes
      : undefined;
  const total_storage_hard_bytes =
    typeof usageLimits.total_storage_hard_bytes === "number" &&
    Number.isFinite(usageLimits.total_storage_hard_bytes)
      ? usageLimits.total_storage_hard_bytes
      : undefined;
  const max_projects =
    typeof usageLimits.max_projects === "number" &&
    Number.isFinite(usageLimits.max_projects)
      ? usageLimits.max_projects
      : undefined;

  return {
    collected_at: new Date().toISOString(),
    owned_project_count,
    sampled_project_count,
    unsampled_project_count,
    measurement_error_count,
    total_storage_bytes,
    total_storage_soft_bytes,
    total_storage_hard_bytes,
    total_storage_soft_remaining_bytes:
      total_storage_soft_bytes != null
        ? total_storage_soft_bytes - total_storage_bytes
        : undefined,
    total_storage_hard_remaining_bytes:
      total_storage_hard_bytes != null
        ? total_storage_hard_bytes - total_storage_bytes
        : undefined,
    over_total_storage_soft:
      total_storage_soft_bytes != null
        ? total_storage_bytes > total_storage_soft_bytes
        : undefined,
    over_total_storage_hard:
      total_storage_hard_bytes != null
        ? total_storage_bytes > total_storage_hard_bytes
        : undefined,
    max_projects,
    remaining_project_slots:
      max_projects != null ? max_projects - owned_project_count : undefined,
    over_max_projects:
      max_projects != null ? owned_project_count > max_projects : undefined,
  };
}
