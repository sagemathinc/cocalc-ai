/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { enqueueCloudVmWork } from "@cocalc/server/cloud";
import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import {
  getDedicatedHostPolicySnapshotForAccount,
  isBillableDedicatedHostCloud,
  selectDedicatedHostFundingLane,
} from "./admission";
import {
  closeDedicatedHostPurchaseSessionForAccount,
  estimateDedicatedHostRateUsdPerHour,
  isDedicatedHostLaneCurrentlyAllowed,
  reconcileDedicatedHostPurchaseSessionForAccount,
  type DedicatedHostFundingLane,
} from "./spend";

const logger = getLogger("server:project-host:spend-maintenance");
const CHECK_INTERVAL_MS = Math.max(
  10_000,
  Number(
    process.env.COCALC_DEDICATED_HOST_SPEND_MAINTENANCE_INTERVAL_MS ?? 30_000,
  ),
);
const LOCK_KEY = "dedicated_host_spend_maintenance";
const ACTIVE_BILLING_STATUSES = new Set([
  "starting",
  "running",
  "restarting",
  "stopping",
  "error",
  "deprovisioning",
]);

let started = false;

type CandidateHostRow = {
  id: string;
  name: string;
  region: string | null;
  status: string | null;
  metadata: any;
};

async function withMaintenanceLock<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const pool = getPool("medium");
  const { rows } = await pool.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    [LOCK_KEY],
  );
  if (!rows[0]?.locked) {
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]);
  }
}

async function listCandidateHosts(): Promise<CandidateHostRow[]> {
  const { rows } = await getPool().query<CandidateHostRow>(
    `
      SELECT id, name, region, status, metadata
      FROM project_hosts
      WHERE deleted IS NULL
        AND metadata IS NOT NULL
        AND metadata->>'owner' IS NOT NULL
      ORDER BY updated DESC
    `,
  );
  return rows;
}

function currentPricingModel(metadata: any): "on_demand" | "spot" {
  const value =
    `${metadata?.effective_pricing_model ?? metadata?.desired_pricing_model ?? metadata?.pricing_model ?? ""}`
      .trim()
      .toLowerCase();
  return value === "spot" ? "spot" : "on_demand";
}

function currentFundingLane(
  metadata: any,
): DedicatedHostFundingLane | undefined {
  const value = `${metadata?.billing?.funding_lane ?? ""}`.trim().toLowerCase();
  if (value === "prepaid" || value === "credit") {
    return value;
  }
  return undefined;
}

async function updateHostBillingMetadata({
  host_id,
  metadata,
}: {
  host_id: string;
  metadata: any;
}): Promise<void> {
  await getPool().query(
    `UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [host_id, metadata],
  );
}

async function requestHostStopForExceededLane({
  row,
  provider,
  reason,
}: {
  row: CandidateHostRow;
  provider: string;
  reason: string;
}): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  if (
    `${metadata?.desired_state ?? ""}`.trim().toLowerCase() === "stopped" &&
    `${row.status ?? ""}`.trim().toLowerCase() === "stopping"
  ) {
    return;
  }
  metadata.desired_state = "stopped";
  metadata.billing = {
    ...(metadata.billing ?? {}),
    stop_reason: reason,
    stop_requested_at: new Date().toISOString(),
  };
  metadata.last_action = "stop";
  metadata.last_action_status = "pending";
  metadata.last_action_error = null;
  metadata.last_action_at = new Date().toISOString();
  await getPool().query(
    `
      UPDATE project_hosts
      SET status=$2, last_seen=$3, metadata=$4, updated=NOW()
      WHERE id=$1 AND deleted IS NULL
    `,
    [row.id, "stopping", null, metadata],
  );
  await enqueueCloudVmWork({
    vm_id: row.id,
    action: "stop",
    payload: { provider },
  });
  logger.warn("stopped dedicated host after billing lane exhaustion", {
    host_id: row.id,
    provider,
    reason,
  });
}

async function runPass(): Promise<void> {
  const rows = await listCandidateHosts();
  const snapshotCache = new Map<
    string,
    AccountLocalDedicatedHostPolicySnapshot
  >();

  const getSnapshot = async (account_id: string) => {
    const cached = snapshotCache.get(account_id);
    if (cached) return cached;
    const snapshot = await getDedicatedHostPolicySnapshotForAccount({
      account_id,
    });
    snapshotCache.set(account_id, snapshot);
    return snapshot;
  };

  for (const row of rows) {
    const metadata = row.metadata ?? {};
    const owner = `${metadata?.owner ?? ""}`.trim();
    const machine = metadata?.machine ?? {};
    const provider = normalizeProviderId(machine.cloud);
    if (!owner || !provider || !isBillableDedicatedHostCloud(provider)) {
      continue;
    }

    const status = `${row.status ?? ""}`.trim().toLowerCase();
    if (!ACTIVE_BILLING_STATUSES.has(status)) {
      await closeDedicatedHostPurchaseSessionForAccount({
        account_id: owner,
        host_id: row.id,
      });
      if (metadata?.billing) {
        const nextMetadata = { ...metadata, billing: null };
        await updateHostBillingMetadata({
          host_id: row.id,
          metadata: nextMetadata,
        });
      }
      snapshotCache.delete(owner);
      continue;
    }

    const snapshot = await getSnapshot(owner);
    if (snapshot.funding_mode === "site-funded") {
      await closeDedicatedHostPurchaseSessionForAccount({
        account_id: owner,
        host_id: row.id,
      });
      const nextBilling = {
        funding_mode: "site-funded" as const,
        started_at: metadata?.billing?.started_at ?? new Date().toISOString(),
      };
      if (
        JSON.stringify(nextBilling) !== JSON.stringify(metadata?.billing ?? {})
      ) {
        await updateHostBillingMetadata({
          host_id: row.id,
          metadata: { ...metadata, billing: nextBilling },
        });
      }
      snapshotCache.delete(owner);
      continue;
    }

    const pricing_model = currentPricingModel(metadata);
    const hourly_cost_usd = await estimateDedicatedHostRateUsdPerHour({
      provider,
      region: row.region,
      zone: machine.zone,
      machine_type: machine.machine_type ?? metadata?.size,
      disk_gb: machine.disk_gb,
      disk_type: machine.disk_type,
      storage_mode: machine.storage_mode,
      gpu_type: machine.gpu_type,
      gpu_count: machine.gpu_count,
      pricing_model,
    });
    if (!hourly_cost_usd) {
      await requestHostStopForExceededLane({
        row,
        provider,
        reason: `pricing unavailable for provider ${provider}`,
      });
      continue;
    }

    let funding_lane = currentFundingLane(metadata);
    if (!funding_lane) {
      funding_lane = selectDedicatedHostFundingLane(snapshot);
      if (!funding_lane) {
        await requestHostStopForExceededLane({
          row,
          provider,
          reason: "dedicated-host funding is not currently available",
        });
        continue;
      }
    }

    await reconcileDedicatedHostPurchaseSessionForAccount({
      account_id: owner,
      host_id: row.id,
      host_name: row.name ?? undefined,
      host_bay_id: getConfiguredBayId(),
      provider,
      region: row.region ?? undefined,
      machine_type: machine.machine_type ?? metadata?.size,
      pricing_model,
      funding_lane,
      hourly_cost_usd,
      started_at: metadata?.billing?.started_at ?? undefined,
    });

    const nextMetadata = {
      ...metadata,
      billing: {
        funding_mode: "account-prepaid" as const,
        funding_lane,
        hourly_cost_usd,
        started_at: metadata?.billing?.started_at ?? new Date().toISOString(),
      },
    };
    if (
      JSON.stringify(nextMetadata.billing) !==
      JSON.stringify(metadata?.billing ?? {})
    ) {
      await updateHostBillingMetadata({
        host_id: row.id,
        metadata: nextMetadata,
      });
    }
    snapshotCache.delete(owner);
    const refreshedSnapshot = await getSnapshot(owner);
    if (
      !isDedicatedHostLaneCurrentlyAllowed({
        snapshot: refreshedSnapshot,
        funding_lane,
      })
    ) {
      await requestHostStopForExceededLane({
        row,
        provider,
        reason: `${funding_lane} dedicated-host window exhausted`,
      });
    }
  }
}

export async function runDedicatedHostSpendMaintenancePass(): Promise<void> {
  await withMaintenanceLock(runPass);
}

export function startDedicatedHostSpendMaintenance(): void {
  if (started) {
    return;
  }
  started = true;
  logger.info("starting dedicated-host spend maintenance loop", {
    CHECK_INTERVAL_MS,
  });
  const run = async () => {
    try {
      await runDedicatedHostSpendMaintenancePass();
    } catch (err) {
      logger.error("dedicated-host spend maintenance failed", err);
    }
  };
  void run();
  const timer = setInterval(() => {
    void run();
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
}
