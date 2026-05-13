/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import centralLog from "@cocalc/database/postgres/central-log";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { getEffectiveMembershipUsageLimits } from "./effective-limits";
import { resolveMembershipForAccount } from "./resolve";
import { humanSize } from "@cocalc/util/misc";
import {
  BUILTIN_ROOTFS_IMAGES,
  isManagedRootfsImageName,
} from "@cocalc/util/rootfs-images";
import type { MembershipResolution } from "@cocalc/conat/hub/api/purchases";

const logger = getLogger("server:membership:rootfs-limits");
const BYTES_PER_GB = 1_000_000_000;

export type RootfsQuotaOperation = "save" | "publish" | "select-project-image";

export interface RootfsUsageSummary {
  count: number;
  total_storage_bytes: number;
}

interface ExistingRootfsSummary {
  image_id: string;
  owner_id: string | null;
  deleted: boolean;
  size_bytes: number;
}

function finiteNonnegative(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return undefined;
  return number;
}

function gbToBytes(value: unknown): number | undefined {
  const gb = finiteNonnegative(value);
  return gb == null ? undefined : Math.floor(gb * BYTES_PER_GB);
}

function formatGb(value: number | undefined): string {
  return value == null ? "not configured" : `${value} GB`;
}

async function recordRootfsQuotaDenial({
  account_id,
  operation,
  limit,
  current,
  maximum,
  requested,
  image,
  image_id,
  reason,
}: {
  account_id: string;
  operation: RootfsQuotaOperation;
  limit: string;
  current?: number;
  maximum?: number;
  requested?: number;
  image?: string;
  image_id?: string;
  reason: string;
}) {
  try {
    await centralLog({
      event: "rootfs_quota_denied",
      value: {
        account_id,
        operation,
        limit,
        current,
        maximum,
        requested,
        image: image ? image.slice(0, 512) : undefined,
        image_id: image_id ? image_id.slice(0, 128) : undefined,
        reason,
        time: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.warn("unable to record rootfs quota denial", {
      account_id,
      operation,
      limit,
      err: `${err}`,
    });
  }
}

function sizeExpression(alias: string): string {
  return `GREATEST(0, COALESCE(rel.size_bytes, ROUND(COALESCE(${alias}.size_gb, 0) * ${BYTES_PER_GB})::BIGINT, 0))`;
}

export async function getRootfsUsageForAccount({
  account_id,
  client,
}: {
  account_id: string;
  client?: PoolClient;
}): Promise<RootfsUsageSummary> {
  const pool = client ?? getPool("medium");
  const { rows } = await pool.query<{
    count: string | number;
    total_storage_bytes: string | number | null;
  }>(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(${sizeExpression("img")}), 0) AS total_storage_bytes
       FROM rootfs_images AS img
       LEFT JOIN rootfs_releases AS rel ON rel.release_id = img.release_id
      WHERE img.owner_id=$1
        AND COALESCE(img.deleted, false)=false`,
    [account_id],
  );
  return {
    count: Math.max(0, Math.floor(Number(rows[0]?.count ?? 0))),
    total_storage_bytes: Math.max(
      0,
      Math.floor(Number(rows[0]?.total_storage_bytes ?? 0)),
    ),
  };
}

async function loadExistingRootfs({
  image_id,
  client,
}: {
  image_id?: string;
  client?: PoolClient;
}): Promise<ExistingRootfsSummary | undefined> {
  const id = `${image_id ?? ""}`.trim();
  if (!id) return undefined;
  const pool = client ?? getPool("medium");
  const { rows } = await pool.query<{
    image_id: string;
    owner_id: string | null;
    deleted: boolean | null;
    size_bytes: string | number | null;
  }>(
    `SELECT img.image_id,
            img.owner_id,
            COALESCE(img.deleted, false) AS deleted,
            ${sizeExpression("img")} AS size_bytes
       FROM rootfs_images AS img
       LEFT JOIN rootfs_releases AS rel ON rel.release_id = img.release_id
      WHERE img.image_id=$1
      LIMIT 1`,
    [id],
  );
  const row = rows[0];
  if (!row) return undefined;
  return {
    image_id: row.image_id,
    owner_id: row.owner_id,
    deleted: row.deleted === true,
    size_bytes: Math.max(0, Math.floor(Number(row.size_bytes ?? 0))),
  };
}

function isBuiltinRootfsImage(image: string): boolean {
  return BUILTIN_ROOTFS_IMAGES.some((entry) => entry.image === image);
}

async function catalogImageIsTrusted({
  image,
  image_id,
}: {
  image: string;
  image_id?: string;
}): Promise<boolean> {
  if (isManagedRootfsImageName(image) || isBuiltinRootfsImage(image)) {
    return true;
  }
  const pool = getPool("medium");
  const params: string[] = [];
  const clauses: string[] = [];
  const id = `${image_id ?? ""}`.trim();
  if (id) {
    params.push(id);
    clauses.push(`image_id=$${params.length}`);
  }
  if (image) {
    params.push(image);
    clauses.push(`runtime_image=$${params.length}`);
  }
  if (!clauses.length) return false;
  const { rows } = await pool.query<{ trusted: boolean }>(
    `SELECT COALESCE(official, false) OR COALESCE(prepull, false) AS trusted
       FROM rootfs_images
      WHERE (${clauses.join(" OR ")})
        AND COALESCE(deleted, false)=false
        AND COALESCE(blocked, false)=false
      ORDER BY trusted DESC
      LIMIT 1`,
    params,
  );
  return rows[0]?.trusted === true;
}

async function assertRemoteOciAllowed({
  account_id,
  image,
  image_id,
  operation,
  resolution,
}: {
  account_id: string;
  image: string;
  image_id?: string;
  operation: RootfsQuotaOperation;
  resolution: MembershipResolution;
}) {
  if (await catalogImageIsTrusted({ image, image_id })) {
    return;
  }
  const limits = getEffectiveMembershipUsageLimits(resolution);
  if (limits.rootfs_oci_images === true) {
    return;
  }
  const reason =
    "arbitrary remote OCI root filesystem images are disabled for this membership tier";
  await recordRootfsQuotaDenial({
    account_id,
    operation,
    limit: "rootfs_oci_images",
    image,
    image_id,
    reason,
  });
  throw new Error(
    `${reason}; choose an official/managed RootFS image or upgrade membership`,
  );
}

export async function assertCanSelectProjectRootfsImage({
  account_id,
  image,
  image_id,
  resolution,
}: {
  account_id: string;
  image: string;
  image_id?: string;
  resolution?: MembershipResolution;
}): Promise<void> {
  const trimmed = `${image ?? ""}`.trim();
  if (!trimmed || (await isAdmin(account_id))) {
    return;
  }
  await assertRemoteOciAllowed({
    account_id,
    image: trimmed,
    image_id,
    operation: "select-project-image",
    resolution: resolution ?? (await resolveMembershipForAccount(account_id)),
  });
}

export async function assertCanCreateOrUpdateRootfs({
  account_id,
  image_id,
  image,
  requested_size_bytes,
  operation,
  resolution,
  client,
}: {
  account_id: string;
  image_id?: string;
  image?: string;
  requested_size_bytes?: number;
  operation: RootfsQuotaOperation;
  resolution?: MembershipResolution;
  client?: PoolClient;
}): Promise<void> {
  if (await isAdmin(account_id)) {
    return;
  }
  const effectiveResolution =
    resolution ?? (await resolveMembershipForAccount(account_id));
  const limits = getEffectiveMembershipUsageLimits(effectiveResolution);
  const trimmedImage = `${image ?? ""}`.trim();
  if (trimmedImage && !isManagedRootfsImageName(trimmedImage)) {
    await assertRemoteOciAllowed({
      account_id,
      image: trimmedImage,
      image_id,
      operation,
      resolution: effectiveResolution,
    });
  }

  const requestedBytes = finiteNonnegative(requested_size_bytes);
  const maxPerRootfsBytes = gbToBytes(limits.rootfs_max_storage_gb);
  if (
    requestedBytes != null &&
    maxPerRootfsBytes != null &&
    requestedBytes > maxPerRootfsBytes
  ) {
    const reason = `rootfs image size ${humanSize(requestedBytes)} exceeds per-rootfs limit ${formatGb(limits.rootfs_max_storage_gb)}`;
    await recordRootfsQuotaDenial({
      account_id,
      operation,
      limit: "rootfs_max_storage_gb",
      requested: requestedBytes,
      maximum: maxPerRootfsBytes,
      image: trimmedImage,
      image_id,
      reason,
    });
    throw new Error(`${reason}; delete data or upgrade membership`);
  }

  const maxCount = limits.rootfs_count;
  const maxTotalBytes = gbToBytes(limits.rootfs_total_storage_gb);
  if (maxCount == null && maxTotalBytes == null) {
    return;
  }

  const [usage, existing] = await Promise.all([
    getRootfsUsageForAccount({ account_id, client }),
    loadExistingRootfs({ image_id, client }),
  ]);
  const replacingOwnActive =
    existing?.owner_id === account_id && existing.deleted !== true;
  const projectedCount = usage.count + (replacingOwnActive ? 0 : 1);
  if (maxCount != null && projectedCount > maxCount) {
    const reason = `rootfs count limit reached (${usage.count}/${maxCount})`;
    await recordRootfsQuotaDenial({
      account_id,
      operation,
      limit: "rootfs_count",
      current: usage.count,
      maximum: maxCount,
      image: trimmedImage,
      image_id,
      reason,
    });
    throw new Error(
      `${reason}; delete a root filesystem or upgrade membership`,
    );
  }

  if (maxTotalBytes == null) {
    return;
  }
  if (requestedBytes == null) {
    if (maxTotalBytes === 0 && !replacingOwnActive) {
      const reason = "rootfs storage quota is zero for this membership tier";
      await recordRootfsQuotaDenial({
        account_id,
        operation,
        limit: "rootfs_total_storage_gb",
        current: usage.total_storage_bytes,
        maximum: maxTotalBytes,
        image: trimmedImage,
        image_id,
        reason,
      });
      throw new Error(
        `${reason}; upgrade membership to create root filesystems`,
      );
    }
    return;
  }
  const projectedTotal =
    usage.total_storage_bytes -
    (replacingOwnActive ? (existing?.size_bytes ?? 0) : 0) +
    requestedBytes;
  if (projectedTotal > maxTotalBytes) {
    const reason = `rootfs total storage limit would be exceeded (${humanSize(usage.total_storage_bytes)} current + ${humanSize(requestedBytes)} requested > ${formatGb(limits.rootfs_total_storage_gb)} limit)`;
    await recordRootfsQuotaDenial({
      account_id,
      operation,
      limit: "rootfs_total_storage_gb",
      current: usage.total_storage_bytes,
      maximum: maxTotalBytes,
      requested: requestedBytes,
      image: trimmedImage,
      image_id,
      reason,
    });
    throw new Error(`${reason}; delete root filesystems or upgrade membership`);
  }
}
