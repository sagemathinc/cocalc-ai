/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import TTL from "@isaacs/ttlcache";
import {
  getDiskQuota,
  type ProjectDiskQuota,
} from "@cocalc/conat/project/storage-info";
import type {
  MembershipResolution,
  MembershipUsageStatus,
} from "@cocalc/conat/hub/api/purchases";
import { conatWithProjectRoutingForAccount } from "@cocalc/server/conat/route-client";
import {
  getManagedEgressUsageForAccount,
  getRecentManagedEgressEventsForAccount,
} from "./managed-egress";
import {
  getManagedCpuUsageForAccount,
  getRecentManagedCpuEventsForAccount,
} from "./managed-cpu";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { getAccountBlobUsage } from "./blob-limits";
import {
  listUsageProjectsForAccount,
  type ProjectUsageRow,
} from "./project-usage";
import { getRootfsUsageForAccount } from "./rootfs-limits";

const log = getLogger("server:membership:usage-status");

const STORAGE_SAMPLE_CONCURRENCY = 8;
const STORAGE_SAMPLE_TIMEOUT_MS = 5_000;
const MEMBERSHIP_USAGE_STATUS_CACHE_TTL_MS = 60_000;

const membershipUsageStatusCache = new TTL<string, MembershipUsageStatus>({
  ttl: MEMBERSHIP_USAGE_STATUS_CACHE_TTL_MS,
});
const membershipUsageStatusInflight = new Map<
  string,
  Promise<MembershipUsageStatus>
>();

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

function extractQuotaUsedBytes(quota: ProjectDiskQuota): number {
  return typeof quota?.used === "number" && Number.isFinite(quota.used)
    ? quota.used
    : 0;
}

function usageStatusCacheKey({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution: MembershipResolution;
}): string {
  const effectiveLimits = getEffectiveMembershipUsageLimits(resolution);
  return JSON.stringify({
    account_id,
    class: resolution.class,
    source: resolution.source,
    expires: resolution.expires ?? null,
    effective_limits: effectiveLimits,
  });
}

export function peekCachedMembershipUsageStatusForAccount({
  account_id,
  resolution,
}: {
  account_id: string;
  resolution: MembershipResolution;
}): MembershipUsageStatus | undefined {
  return membershipUsageStatusCache.get(
    usageStatusCacheKey({ account_id, resolution }),
  );
}

async function listAttributedProjects(
  account_id: string,
): Promise<ProjectUsageRow[]> {
  return await listUsageProjectsForAccount(account_id);
}

async function sampleProjectStorageBytes({
  project_id,
  client,
}: {
  project_id: string;
  client: ReturnType<typeof conatWithProjectRoutingForAccount>;
}): Promise<number> {
  const quota = await withTimeout(
    getDiskQuota({
      client,
      project_id,
    }),
    STORAGE_SAMPLE_TIMEOUT_MS,
  );
  return extractQuotaUsedBytes(quota);
}

export async function getMembershipUsageStatusForAccount({
  account_id,
  resolution,
  fresh = false,
}: {
  account_id: string;
  resolution: MembershipResolution;
  fresh?: boolean;
}): Promise<MembershipUsageStatus> {
  const cacheKey = usageStatusCacheKey({ account_id, resolution });
  if (!fresh) {
    const cached = membershipUsageStatusCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const inflight = membershipUsageStatusInflight.get(cacheKey);
    if (inflight) {
      return await inflight;
    }
  }

  const load = (async (): Promise<MembershipUsageStatus> => {
    const effectiveLimits = getEffectiveMembershipUsageLimits(resolution);
    const attributedProjects = await listAttributedProjects(account_id);
    const provisionedRows = attributedProjects.filter(
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
            log.debug("unable to sample attributed project storage", {
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

    const owned_project_count = attributedProjects.length;
    const unsampled_project_count = Math.max(
      provisionedRows.length - sampled_project_count,
      0,
    );
    const total_storage_soft_bytes = effectiveLimits.total_storage_soft_bytes;
    const total_storage_hard_bytes = effectiveLimits.total_storage_hard_bytes;
    const max_projects = effectiveLimits.max_projects;
    const egress5hLimit = effectiveLimits.egress_5h_bytes;
    const egress7dLimit = effectiveLimits.egress_7d_bytes;
    const managedEgress = await getManagedEgressUsageForAccount({
      account_id,
      limit5h: egress5hLimit,
      limit7d: egress7dLimit,
    });
    const managedEgressRecentEvents =
      await getRecentManagedEgressEventsForAccount({
        account_id,
        limit: 20,
      });
    const managedCpu = await getManagedCpuUsageForAccount({ account_id });
    const managedCpuRecentEvents = await getRecentManagedCpuEventsForAccount({
      account_id,
      limit: 20,
    });
    const rootfsUsage = await getRootfsUsageForAccount({ account_id });
    const rootfs_count_limit = effectiveLimits.rootfs_count;
    const rootfs_total_storage_bytes_limit =
      typeof effectiveLimits.rootfs_total_storage_gb === "number"
        ? Math.floor(effectiveLimits.rootfs_total_storage_gb * 1_000_000_000)
        : undefined;
    const rootfs_max_storage_bytes_limit =
      typeof effectiveLimits.rootfs_max_storage_gb === "number"
        ? Math.floor(effectiveLimits.rootfs_max_storage_gb * 1_000_000_000)
        : undefined;
    const blobUsage = await getAccountBlobUsage({ account_id });
    const blob_count_limit = effectiveLimits.blob_account_count;
    const blob_total_bytes_limit = effectiveLimits.blob_account_total_bytes;

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
      rootfs_count: rootfsUsage.count,
      rootfs_count_limit,
      rootfs_remaining_count:
        rootfs_count_limit != null
          ? rootfs_count_limit - rootfsUsage.count
          : undefined,
      over_rootfs_count:
        rootfs_count_limit != null
          ? rootfsUsage.count > rootfs_count_limit
          : undefined,
      rootfs_total_storage_bytes: rootfsUsage.total_storage_bytes,
      rootfs_total_storage_bytes_limit,
      rootfs_total_storage_remaining_bytes:
        rootfs_total_storage_bytes_limit != null
          ? rootfs_total_storage_bytes_limit - rootfsUsage.total_storage_bytes
          : undefined,
      over_rootfs_total_storage:
        rootfs_total_storage_bytes_limit != null
          ? rootfsUsage.total_storage_bytes > rootfs_total_storage_bytes_limit
          : undefined,
      rootfs_max_storage_bytes_limit,
      blob_count: blobUsage.count,
      blob_count_limit,
      blob_remaining_count:
        blob_count_limit != null
          ? blob_count_limit - blobUsage.count
          : undefined,
      over_blob_count:
        blob_count_limit != null
          ? blobUsage.count > blob_count_limit
          : undefined,
      blob_total_bytes: blobUsage.total_bytes,
      blob_total_bytes_limit,
      blob_total_remaining_bytes:
        blob_total_bytes_limit != null
          ? blob_total_bytes_limit - blobUsage.total_bytes
          : undefined,
      over_blob_total_storage:
        blob_total_bytes_limit != null
          ? blobUsage.total_bytes > blob_total_bytes_limit
          : undefined,
      blob_project_count_limit: effectiveLimits.blob_project_count,
      blob_project_total_bytes_limit: effectiveLimits.blob_project_total_bytes,
      ...managedEgress,
      managed_egress_recent_events: managedEgressRecentEvents,
      managed_cpu_5h_seconds: managedCpu.managed_cpu_5h_seconds,
      managed_cpu_7d_seconds: managedCpu.managed_cpu_7d_seconds,
      managed_cpu_5h_remaining_seconds:
        managedCpu.managed_cpu_5h_remaining_seconds,
      managed_cpu_7d_remaining_seconds:
        managedCpu.managed_cpu_7d_remaining_seconds,
      managed_cpu_5h_reset_at: managedCpu.managed_cpu_5h_reset_at,
      managed_cpu_7d_reset_at: managedCpu.managed_cpu_7d_reset_at,
      managed_cpu_5h_reset_in: managedCpu.managed_cpu_5h_reset_in,
      managed_cpu_7d_reset_in: managedCpu.managed_cpu_7d_reset_in,
      over_managed_cpu_5h: managedCpu.over_managed_cpu_5h,
      over_managed_cpu_7d: managedCpu.over_managed_cpu_7d,
      managed_cpu_recent_events: managedCpuRecentEvents,
    };
  })();

  if (fresh) {
    return await load;
  }
  membershipUsageStatusInflight.set(cacheKey, load);
  try {
    const value = await load;
    membershipUsageStatusCache.set(cacheKey, value);
    return value;
  } finally {
    if (membershipUsageStatusInflight.get(cacheKey) === load) {
      membershipUsageStatusInflight.delete(cacheKey);
    }
  }
}
