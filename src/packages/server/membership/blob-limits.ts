/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import type { MembershipEffectiveLimits } from "@cocalc/conat/hub/api/purchases";
import { humanSize } from "@cocalc/util/misc";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { getProjectUsageAccountId } from "./project-usage";
import { resolveMembershipForAccount } from "./resolve";

const logger = getLogger("server:membership:blob-limits");

export interface BlobUsageSummary {
  count: number;
  total_bytes: number;
}

type BlobQuotaLimit =
  | "blob_account_total_bytes"
  | "blob_account_count"
  | "blob_project_total_bytes"
  | "blob_project_count";

function finiteNonnegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return Math.floor(number);
}

function formatCount(value: number | undefined): string {
  return value == null ? "not configured" : `${value}`;
}

function formatBytes(value: number | undefined): string {
  return value == null ? "not configured" : humanSize(value);
}

async function recordBlobQuotaDenial({
  account_id,
  project_id,
  limit,
  current,
  maximum,
  requested,
  reason,
}: {
  account_id?: string;
  project_id?: string;
  limit: BlobQuotaLimit;
  current: number;
  maximum: number;
  requested: number;
  reason: string;
}) {
  try {
    await centralLog({
      event: "blob_quota_denied",
      value: {
        account_id,
        project_id,
        limit,
        current,
        maximum,
        requested,
        reason,
        time: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn("failed to write blob quota denial event", {
      account_id,
      project_id,
      limit,
      err: `${err}`,
    });
  }
}

function assertUnderLimit({
  account_id,
  project_id,
  limit,
  current,
  maximum,
  requested,
  format,
}: {
  account_id?: string;
  project_id?: string;
  limit: BlobQuotaLimit;
  current: number;
  maximum: number | undefined;
  requested: number;
  format: (value: number | undefined) => string;
}) {
  if (maximum == null) return;
  const projected = current + requested;
  if (projected <= maximum) return;
  const scope = project_id ? "project" : "account";
  const reason = `Blob ${scope} quota exceeded for ${limit}: current ${format(
    current,
  )}, requested ${format(requested)}, limit ${format(maximum)}`;
  void recordBlobQuotaDenial({
    account_id,
    project_id,
    limit,
    current,
    maximum,
    requested,
    reason,
  });
  throw Error(reason);
}

async function blobExists({
  uuid,
  client,
}: {
  uuid: string;
  client?: PoolClient;
}): Promise<boolean> {
  const { rows } = await (client ?? getPool()).query(
    "SELECT 1 FROM blobs WHERE id=$1::uuid LIMIT 1",
    [uuid],
  );
  return rows.length > 0;
}

export async function getAccountBlobUsage({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<BlobUsageSummary> {
  const { rows } = await (client ?? getPool()).query<{
    count: number | string;
    total_bytes: number | string;
  }>(
    `
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(COALESCE(size, 0)), 0)::bigint AS total_bytes
        FROM blobs
       WHERE account_id=$1::uuid
         AND (expire IS NULL OR expire > NOW())
    `,
    [account_id],
  );
  return {
    count: Number(rows[0]?.count) || 0,
    total_bytes: Number(rows[0]?.total_bytes) || 0,
  };
}

export async function getProjectBlobUsage({
  project_id,
  client,
}: {
  project_id: string;
  client?: PoolClient;
}): Promise<BlobUsageSummary> {
  const { rows } = await (client ?? getPool()).query<{
    count: number | string;
    total_bytes: number | string;
  }>(
    `
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(COALESCE(size, 0)), 0)::bigint AS total_bytes
        FROM blobs
       WHERE project_id=$1
         AND (expire IS NULL OR expire > NOW())
    `,
    [project_id],
  );
  return {
    count: Number(rows[0]?.count) || 0,
    total_bytes: Number(rows[0]?.total_bytes) || 0,
  };
}

async function limitsForAccount(
  account_id: string,
  cache: Map<string, Promise<MembershipEffectiveLimits>>,
): Promise<MembershipEffectiveLimits> {
  let limits = cache.get(account_id);
  if (!limits) {
    limits = resolveMembershipForAccount(account_id).then((resolution) =>
      getEffectiveMembershipUsageLimits(resolution),
    );
    cache.set(account_id, limits);
  }
  return await limits;
}

export async function assertCanSaveBlobForAccount({
  account_id,
  project_id,
  uuid,
  blobSize,
  client,
}: {
  account_id?: string;
  project_id?: string;
  uuid: string;
  blobSize: number;
  client?: PoolClient;
}): Promise<void> {
  if (blobSize <= 0) return;
  if (await blobExists({ uuid, client })) {
    return;
  }

  const limitCache = new Map<string, Promise<MembershipEffectiveLimits>>();

  if (account_id) {
    const [limits, usage] = await Promise.all([
      limitsForAccount(account_id, limitCache),
      getAccountBlobUsage({ account_id, client }),
    ]);
    assertUnderLimit({
      account_id,
      limit: "blob_account_count",
      current: usage.count,
      maximum: finiteNonnegativeInteger(limits.blob_account_count),
      requested: 1,
      format: formatCount,
    });
    assertUnderLimit({
      account_id,
      limit: "blob_account_total_bytes",
      current: usage.total_bytes,
      maximum: finiteNonnegativeInteger(limits.blob_account_total_bytes),
      requested: blobSize,
      format: formatBytes,
    });
  }

  if (project_id) {
    const projectUsageAccountId =
      (await getProjectUsageAccountId(project_id, client)) ?? account_id;
    if (!projectUsageAccountId) {
      logger.warn("skipping project blob quota check without usage account", {
        project_id,
      });
      return;
    }
    const [limits, usage] = await Promise.all([
      limitsForAccount(projectUsageAccountId, limitCache),
      getProjectBlobUsage({ project_id, client }),
    ]);
    assertUnderLimit({
      account_id: projectUsageAccountId,
      project_id,
      limit: "blob_project_count",
      current: usage.count,
      maximum: finiteNonnegativeInteger(limits.blob_project_count),
      requested: 1,
      format: formatCount,
    });
    assertUnderLimit({
      account_id: projectUsageAccountId,
      project_id,
      limit: "blob_project_total_bytes",
      current: usage.total_bytes,
      maximum: finiteNonnegativeInteger(limits.blob_project_total_bytes),
      requested: blobSize,
      format: formatBytes,
    });
  }
}
