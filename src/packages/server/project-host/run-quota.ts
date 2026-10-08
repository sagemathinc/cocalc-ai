/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { Quota } from "@cocalc/util/upgrades/quota";

import { machineHasGpu } from "../cloud/host-gpu";

type HostRuntimePolicy = {
  tier?: number | null;
  metadata?: any;
};

const PRIVATE_HOST_RAM_RESERVE_MB = 3 * 1024;

function positiveFiniteNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function privateHostDefaultMemoryLimitMb(metadata: any): number | undefined {
  const hostRamMb =
    positiveFiniteNumber(metadata.host_ram_mb) ??
    (positiveFiniteNumber(metadata.host_ram_gb) != null
      ? positiveFiniteNumber(metadata.host_ram_gb)! * 1024
      : undefined) ??
    (positiveFiniteNumber(metadata.machine?.metadata?.ram_gb) != null
      ? positiveFiniteNumber(metadata.machine.metadata.ram_gb)! * 1024
      : undefined);
  if (hostRamMb == null) {
    return undefined;
  }
  return Math.max(500, Math.floor(hostRamMb - PRIVATE_HOST_RAM_RESERVE_MB));
}

export function applyHostRuntimePolicy({
  run_quota,
  host,
}: {
  run_quota?: Quota | null;
  host?: HostRuntimePolicy | null;
}): Quota {
  const quota: Quota = run_quota ? { ...run_quota } : {};
  if (!host) return quota;

  const metadata = host.metadata ?? {};
  if (machineHasGpu(metadata.machine ?? {})) {
    quota.gpu = true;
  } else {
    if (Object.prototype.hasOwnProperty.call(quota, "gpu")) {
      quota.gpu = false;
    }
    delete (quota as Record<string, unknown>).gpu_count;
  }

  const hostMemory = positiveFiniteNumber(
    metadata.resources?.project_ram_limit_mb,
  );
  if (host.tier == null) {
    // A private host is itself the paid resource. An explicit cap wins;
    // otherwise projects receive the maximum safe host capacity instead of
    // being constrained by the user's unrelated shared-host membership.
    const privateHostMemory =
      hostMemory ?? privateHostDefaultMemoryLimitMb(metadata);
    if (privateHostMemory != null) {
      quota.memory_limit = privateHostMemory;
    }
  } else if (hostMemory != null) {
    // Shared-pool hosts must never grant RAM beyond project entitlement.
    const projectMemory = positiveFiniteNumber(quota.memory_limit);
    quota.memory_limit =
      projectMemory == null ? hostMemory : Math.min(projectMemory, hostMemory);
  }
  return quota;
}

export async function applyHostRuntimePolicyToRunQuota(
  run_quota: Quota | null | undefined,
  host_id?: string | null,
): Promise<Quota> {
  if (!host_id) return run_quota ? { ...run_quota } : {};
  const { rows } = await getPool().query(
    "SELECT tier, metadata FROM project_hosts WHERE id=$1 AND deleted IS NULL",
    [host_id],
  );
  return applyHostRuntimePolicy({ run_quota, host: rows[0] });
}
