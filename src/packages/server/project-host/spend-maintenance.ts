/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { enqueueCloudVmWork } from "@cocalc/server/cloud";
import { createLro } from "@cocalc/server/lro/lro-db";
import type { AccountLocalDedicatedHostPolicySnapshot } from "@cocalc/conat/inter-bay/api";
import {
  applyDedicatedHostFundingModeOverride,
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
import {
  DEDICATED_HOST_BILLING_DISK_GRACE_HOURS,
  buildDedicatedHostBillingEnforcementMetadata,
  evaluateDedicatedHostBillingEnforcement,
  type DedicatedHostBillingEnforcementMetadata,
} from "./spend-enforcement";
import { notifyDedicatedHostBillingEnforcementBestEffort } from "./billing-notifications";

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
  "draining",
  "stopping",
  "error",
  "deprovisioning",
]);
const HOST_DRAIN_LRO_KIND = "host-drain";
const HOST_DEPROVISION_LRO_KIND = "host-deprovision";

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

function currentFundingMode(
  metadata: any,
): "account-prepaid" | "account-postpaid" | "site-funded" | undefined {
  const value = `${metadata?.billing?.funding_mode ?? ""}`.trim().toLowerCase();
  if (
    value === "account-prepaid" ||
    value === "account-postpaid" ||
    value === "site-funded"
  ) {
    return value;
  }
  return undefined;
}

function retainedBillingPolicy(metadata: any): any {
  const funding_mode = currentFundingMode(metadata);
  if (!funding_mode) {
    return null;
  }
  const enforcement = currentEnforcement(metadata);
  const started_at =
    typeof metadata?.billing?.started_at === "string"
      ? metadata.billing.started_at.trim()
      : "";
  return {
    funding_mode,
    ...(started_at ? { started_at } : {}),
    ...(enforcement ? { enforcement } : {}),
  };
}

function currentEnforcement(
  metadata: any,
): DedicatedHostBillingEnforcementMetadata | undefined {
  const enforcement = metadata?.billing?.enforcement;
  return enforcement && typeof enforcement === "object"
    ? enforcement
    : undefined;
}

async function notifyBillingEnforcementTransition({
  row,
  owner,
  previous,
  next,
}: {
  row: CandidateHostRow;
  owner: string;
  previous?: DedicatedHostBillingEnforcementMetadata;
  next: DedicatedHostBillingEnforcementMetadata;
}): Promise<void> {
  if (!owner || previous?.state === next.state) return;
  await notifyDedicatedHostBillingEnforcementBestEffort({
    owner_account_id: owner,
    host_id: row.id,
    host_name: row.name,
    state: next.state,
    previous_state: previous?.state,
    reason: next.reason,
    final_backup_status: next.final_backup_status,
    deprovision_after: next.deprovision_after,
    recovery_actions: next.recovery_actions,
  });
}

function nextDrainingEnforcement({
  metadata,
  reason_code,
  reason,
  recovery_actions,
}: {
  metadata: any;
  reason_code: string;
  reason: string;
  recovery_actions: DedicatedHostBillingEnforcementMetadata["recovery_actions"];
}): DedicatedHostBillingEnforcementMetadata {
  const previous = currentEnforcement(metadata);
  const nowIso = new Date().toISOString();
  const previousFinalBackupStatus = previous?.final_backup_status;
  return {
    ...(previous ?? {}),
    state: "draining",
    reason_code,
    reason,
    first_detected_at: previous?.first_detected_at ?? nowIso,
    drain_requested_at: previous?.drain_requested_at ?? nowIso,
    final_backup_status:
      previousFinalBackupStatus === "succeeded" ||
      previousFinalBackupStatus === "failed"
        ? previousFinalBackupStatus
        : "running",
    recovery_actions,
  };
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
  finalBackupStatus,
}: {
  row: CandidateHostRow;
  provider: string;
  reason: string;
  finalBackupStatus?: "unknown" | "running" | "succeeded" | "failed";
}): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  const owner = `${metadata?.owner ?? ""}`.trim();
  const previousEnforcement = currentEnforcement(metadata);
  if (
    `${metadata?.desired_state ?? ""}`.trim().toLowerCase() === "stopped" &&
    `${row.status ?? ""}`.trim().toLowerCase() === "stopping"
  ) {
    return;
  }
  metadata.desired_state = "stopped";
  const now = new Date();
  const graceUntil = new Date(
    now.valueOf() + DEDICATED_HOST_BILLING_DISK_GRACE_HOURS * 3600_000,
  ).toISOString();
  metadata.billing = {
    ...(metadata.billing ?? {}),
    enforcement: {
      ...(metadata.billing?.enforcement ?? {}),
      state: "stopped_billing_blocked",
      reason,
      stopped_at: now.toISOString(),
      grace_until: graceUntil,
      deprovision_after: graceUntil,
      final_backup_status:
        finalBackupStatus ??
        metadata.billing?.enforcement?.final_backup_status ??
        "unknown",
      recovery_actions: metadata.billing?.enforcement?.recovery_actions ?? [
        "add_funds",
        "fix_payment",
        "support_limit_increase",
      ],
    },
    stop_reason: reason,
    stop_requested_at: now.toISOString(),
  };
  metadata.last_action = "stop";
  metadata.last_action_status = "pending";
  metadata.last_action_error = null;
  metadata.last_action_at = now.toISOString();
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
  await notifyBillingEnforcementTransition({
    row,
    owner,
    previous: previousEnforcement,
    next: metadata.billing.enforcement,
  });
  logger.warn("stopped dedicated host after billing lane exhaustion", {
    host_id: row.id,
    provider,
    reason,
  });
}

async function countProjectsAssignedToHost(host_id: string): Promise<number> {
  const { rows } = await getPool("medium").query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM projects
      WHERE host_id=$1
        AND deleted IS NOT true
    `,
    [host_id],
  );
  return Number(rows[0]?.count ?? 0);
}

async function updateHostStatusAndBillingMetadata({
  row,
  status,
  metadata,
}: {
  row: CandidateHostRow;
  status: string;
  metadata: any;
}): Promise<void> {
  await getPool().query(
    `
      UPDATE project_hosts
      SET status=$2, metadata=$3, updated=NOW()
      WHERE id=$1 AND deleted IS NULL
    `,
    [row.id, status, metadata],
  );
}

async function requestHostDrainForBilling({
  row,
  enforcement,
}: {
  row: CandidateHostRow;
  enforcement: DedicatedHostBillingEnforcementMetadata;
}): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  const owner = `${metadata?.owner ?? ""}`.trim();
  if (!owner) {
    return;
  }
  const previousEnforcement = currentEnforcement(metadata);
  const nextMetadata = {
    ...metadata,
    billing: {
      ...(metadata.billing ?? {}),
      enforcement,
    },
    last_action: "drain",
    last_action_status: "pending",
    last_action_error: null,
    last_action_at: new Date().toISOString(),
  };
  await updateHostStatusAndBillingMetadata({
    row,
    status: "draining",
    metadata: nextMetadata,
  });
  await createLro({
    kind: HOST_DRAIN_LRO_KIND,
    scope_type: "host",
    scope_id: row.id,
    created_by: owner,
    routing: "hub",
    input: {
      id: row.id,
      account_id: owner,
      allow_offline: true,
      force: false,
      managed_egress_override: "admin-host-drain",
      billing_enforcement: true,
    },
    dedupe_key: `${HOST_DRAIN_LRO_KIND}:billing:${row.id}`,
    status: "queued",
  });
  await notifyBillingEnforcementTransition({
    row,
    owner,
    previous: previousEnforcement,
    next: enforcement,
  });
  logger.warn("requested dedicated host drain for billing enforcement", {
    host_id: row.id,
    reason_code: enforcement.reason_code,
    reason: enforcement.reason,
  });
}

async function requestHostDeprovisionForBilling({
  row,
}: {
  row: CandidateHostRow;
}): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  const owner = `${metadata?.owner ?? ""}`.trim();
  if (!owner) return;
  const enforcement = currentEnforcement(metadata);
  const previousEnforcement = enforcement;
  const nowIso = new Date().toISOString();
  const nextMetadata = {
    ...metadata,
    desired_state: "stopped",
    billing: {
      ...(metadata.billing ?? {}),
      enforcement: {
        ...(enforcement ?? {}),
        state: "deprovision_pending",
        deprovision_requested_at:
          enforcement?.deprovision_requested_at ?? nowIso,
      },
    },
    last_action: "deprovision",
    last_action_status: "pending",
    last_action_error: null,
    last_action_at: nowIso,
  };
  await updateHostBillingMetadata({
    host_id: row.id,
    metadata: nextMetadata,
  });
  await createLro({
    kind: HOST_DEPROVISION_LRO_KIND,
    scope_type: "host",
    scope_id: row.id,
    created_by: owner,
    routing: "hub",
    input: {
      id: row.id,
      account_id: owner,
      skip_backups: true,
      billing_enforcement: true,
    },
    dedupe_key: `${HOST_DEPROVISION_LRO_KIND}:billing:${row.id}`,
    status: "queued",
  });
  await notifyBillingEnforcementTransition({
    row,
    owner,
    previous: previousEnforcement,
    next: nextMetadata.billing.enforcement,
  });
  logger.warn("requested dedicated host deprovision for billing enforcement", {
    host_id: row.id,
  });
}

async function maybeProgressInactiveEnforcement({
  row,
}: {
  row: CandidateHostRow;
}): Promise<boolean> {
  const metadata = row.metadata ?? {};
  const enforcement = currentEnforcement(metadata);
  if (
    enforcement?.state === "deprovision_pending" &&
    `${row.status ?? ""}`.trim().toLowerCase() === "deprovisioned"
  ) {
    const owner = `${metadata?.owner ?? ""}`.trim();
    const nextEnforcement = {
      ...enforcement,
      state: "deprovisioned_recoverable" as const,
      deprovisioned_at:
        enforcement.deprovisioned_at ?? new Date().toISOString(),
    };
    await updateHostBillingMetadata({
      host_id: row.id,
      metadata: {
        ...metadata,
        billing: {
          ...(metadata.billing ?? {}),
          enforcement: nextEnforcement,
        },
      },
    });
    await notifyBillingEnforcementTransition({
      row,
      owner,
      previous: enforcement,
      next: nextEnforcement,
    });
    return true;
  }
  if (
    enforcement?.state !== "stopped_billing_blocked" ||
    enforcement.final_backup_status !== "succeeded" ||
    !enforcement.deprovision_after
  ) {
    return false;
  }
  const deprovisionAfter = new Date(enforcement.deprovision_after).getTime();
  if (!Number.isFinite(deprovisionAfter) || deprovisionAfter > Date.now()) {
    return false;
  }
  await requestHostDeprovisionForBilling({ row });
  return true;
}

async function maybeClearRecoveredInactiveEnforcement({
  row,
  provider,
  snapshot,
}: {
  row: CandidateHostRow;
  provider: string;
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
}): Promise<boolean> {
  const metadata = row.metadata ?? {};
  const enforcement = currentEnforcement(metadata);
  if (
    !enforcement ||
    !["at_risk", "stopped_billing_blocked"].includes(enforcement.state)
  ) {
    return false;
  }
  const effectiveSnapshot = applyDedicatedHostFundingModeOverride(
    snapshot,
    currentFundingMode(metadata),
  );
  if (effectiveSnapshot.funding_mode === "site-funded") {
    const nextEnforcement = { state: "ok" as const };
    await updateHostBillingMetadata({
      host_id: row.id,
      metadata: {
        ...metadata,
        billing: {
          ...(metadata.billing ?? {}),
          funding_mode: "site-funded",
          enforcement: nextEnforcement,
        },
      },
    });
    await notifyBillingEnforcementTransition({
      row,
      owner: `${metadata?.owner ?? ""}`.trim(),
      previous: enforcement,
      next: nextEnforcement,
    });
    return true;
  }

  const funding_lane =
    selectDedicatedHostFundingLane(effectiveSnapshot) ??
    currentFundingLane(metadata);
  if (!funding_lane) return false;
  if (
    !isDedicatedHostLaneCurrentlyAllowed({
      snapshot: effectiveSnapshot,
      funding_lane,
    })
  ) {
    return false;
  }
  const machine = metadata?.machine ?? {};
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
    pricing_model: currentPricingModel(metadata),
  });
  if (!hourly_cost_usd) return false;

  const nextEnforcement = { state: "ok" as const };
  await updateHostBillingMetadata({
    host_id: row.id,
    metadata: {
      ...metadata,
      billing: {
        ...(metadata.billing ?? {}),
        funding_mode: effectiveSnapshot.funding_mode,
        funding_lane,
        hourly_cost_usd,
        enforcement: nextEnforcement,
      },
    },
  });
  await notifyBillingEnforcementTransition({
    row,
    owner: `${metadata?.owner ?? ""}`.trim(),
    previous: enforcement,
    next: nextEnforcement,
  });
  logger.info("cleared recovered dedicated host billing enforcement", {
    host_id: row.id,
    funding_lane,
  });
  return true;
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
      if (
        await maybeClearRecoveredInactiveEnforcement({
          row,
          provider,
          snapshot: await getSnapshot(owner),
        })
      ) {
        snapshotCache.delete(owner);
        continue;
      }
      if (await maybeProgressInactiveEnforcement({ row })) {
        snapshotCache.delete(owner);
        continue;
      }
      if (metadata?.billing) {
        const nextMetadata = {
          ...metadata,
          billing: retainedBillingPolicy(metadata),
        };
        await updateHostBillingMetadata({
          host_id: row.id,
          metadata: nextMetadata,
        });
      }
      snapshotCache.delete(owner);
      continue;
    }

    const enforcement = currentEnforcement(metadata);
    if (enforcement?.state === "draining") {
      const assignedProjects = await countProjectsAssignedToHost(row.id);
      if (assignedProjects === 0) {
        await requestHostStopForExceededLane({
          row,
          provider,
          reason: enforcement.reason ?? "billing enforcement drain complete",
          finalBackupStatus: "succeeded",
        });
      }
      snapshotCache.delete(owner);
      continue;
    }

    const snapshot = applyDedicatedHostFundingModeOverride(
      await getSnapshot(owner),
      currentFundingMode(metadata),
    );
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
      await requestHostDrainForBilling({
        row,
        enforcement: nextDrainingEnforcement({
          metadata,
          reason_code: "host_pricing_unavailable",
          reason: `pricing unavailable for provider ${provider}`,
          recovery_actions: ["support_limit_increase"],
        }),
      });
      continue;
    }

    const selectedFundingLane = selectDedicatedHostFundingLane(snapshot);
    let funding_lane = selectedFundingLane ?? currentFundingLane(metadata);
    if (!funding_lane) {
      await requestHostDrainForBilling({
        row,
        enforcement: nextDrainingEnforcement({
          metadata,
          reason_code: "dedicated_host_funding_unavailable",
          reason: "dedicated-host funding is not currently available",
          recovery_actions: [
            "add_funds",
            "fix_payment",
            "support_limit_increase",
          ],
        }),
      });
      continue;
    }
    const existingFundingMode = currentFundingMode(metadata);
    const preserveStartedAt =
      existingFundingMode === snapshot.funding_mode &&
      currentFundingLane(metadata) === funding_lane
        ? metadata?.billing?.started_at
        : undefined;

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
      started_at: preserveStartedAt,
    });

    snapshotCache.delete(owner);
    const refreshedSnapshot = applyDedicatedHostFundingModeOverride(
      await getSnapshot(owner),
      currentFundingMode({
        ...metadata,
        billing: {
          ...(metadata.billing ?? {}),
          funding_mode: snapshot.funding_mode,
          funding_lane,
        },
      }),
    );
    const laneAllowed = isDedicatedHostLaneCurrentlyAllowed({
      snapshot: refreshedSnapshot,
      funding_lane,
    });
    const enforcementDecision = evaluateDedicatedHostBillingEnforcement({
      snapshot: refreshedSnapshot,
      funding_lane,
      hourly_cost_usd,
      lane_allowed: laneAllowed,
    });
    const nextEnforcement = buildDedicatedHostBillingEnforcementMetadata({
      previous: currentEnforcement(metadata),
      decision: enforcementDecision,
      hourly_cost_usd,
    });

    const nextMetadata = {
      ...metadata,
      billing: {
        funding_mode: snapshot.funding_mode,
        funding_lane,
        hourly_cost_usd,
        started_at: preserveStartedAt ?? new Date().toISOString(),
        enforcement: nextEnforcement,
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
      if (enforcementDecision.action !== "request_drain") {
        await notifyBillingEnforcementTransition({
          row,
          owner,
          previous: currentEnforcement(metadata),
          next: nextEnforcement,
        });
      }
    }
    snapshotCache.delete(owner);
    if (enforcementDecision.action === "request_drain") {
      await requestHostDrainForBilling({
        row,
        enforcement: nextEnforcement,
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
