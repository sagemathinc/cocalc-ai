/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { withSessionAdvisoryLock } from "@cocalc/database/pool";
import { normalizeProviderId } from "@cocalc/cloud";
import adminAlert from "@cocalc/server/messages/admin-alert";
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
  dedicatedHostRateFromPricingSnapshot,
  estimateDedicatedHostRate,
  getDedicatedHostWindowUsageForHostLocal,
  isDedicatedHostLaneCurrentlyAllowed,
  reconcileDedicatedHostPurchaseSessionForAccount,
  type DedicatedHostFundingLane,
  type DedicatedHostOwnerWindowUsageSnapshot,
} from "./spend";
import {
  DEDICATED_HOST_BILLING_DISK_GRACE_HOURS,
  buildDedicatedHostBillingEnforcementMetadata,
  evaluateDedicatedHostBillingEnforcement,
  type DedicatedHostBillingEnforcementMetadata,
} from "./spend-enforcement";
import {
  notifyDedicatedHostBillingEnforcementBestEffort,
  notifyDedicatedHostDeprovisionReminderBestEffort,
} from "./billing-notifications";
import {
  moneyToDbString,
  toDecimal,
  type MoneyValue,
} from "@cocalc/util/money";
import type { DedicatedHostBillingState } from "@cocalc/util/project-host-pricing";
import { hostLifecycleFenced } from "@cocalc/server/hosts/maintenance";

const logger = getLogger("server:project-host:spend-maintenance");
const CHECK_INTERVAL_MS = Math.max(
  10_000,
  Number(
    process.env.COCALC_DEDICATED_HOST_SPEND_MAINTENANCE_INTERVAL_MS ?? 30_000,
  ),
);
const LOCK_KEY = "dedicated_host_spend_maintenance";
const RUNNING_BILLING_STATUSES = new Set([
  "starting",
  "running",
  "restarting",
  "draining",
  "stopping",
  "error",
]);
const HOST_DRAIN_LRO_KIND = "host-drain";
const HOST_DEPROVISION_LRO_KIND = "host-deprovision";
const DEPROVISION_REMINDER_LEAD_MS = 24 * 3600_000;

let started = false;

type CandidateHostRow = {
  id: string;
  name: string;
  region: string | null;
  status: string | null;
  metadata: any;
  maintenance?: any;
};

// This pass writes back whole metadata objects it read earlier. While a
// relocation holds the host it must not write at all (it would stop the VM
// mid-move or restore the old placement); after a relocation (or any other
// placement change) a write based on the old placement is dropped and the
// next pass decides again from a fresh read.
function hostWriteGuard(metadataParam: number): string {
  return `
        AND COALESCE(maintenance->>'state', '') NOT IN ('preparing','in_progress','failed')
        AND metadata->'machine' IS NOT DISTINCT FROM ($${metadataParam}::jsonb)->'machine'`;
}

export function billingStateForHost(
  row: CandidateHostRow,
): DedicatedHostBillingState | undefined {
  const status = `${row.status ?? ""}`.trim().toLowerCase();
  const runtime = row.metadata?.runtime;
  const instanceId = `${runtime?.instance_id ?? ""}`.trim();
  const providerStatus = `${runtime?.provider_status ?? ""}`
    .trim()
    .toLowerCase();

  // A generic host error can still represent a provider VM that is accruing
  // charges.  An explicit provider "missing" observation is different: never
  // charge VM/GPU rates for an instance the provider says does not exist.  A
  // retained disk may still be billable until reconciliation confirms that it
  // is also gone, so use stopped pricing while the runtime identity remains.
  if (providerStatus === "missing") {
    return instanceId ? "stopped" : undefined;
  }
  if (RUNNING_BILLING_STATUSES.has(status)) {
    return "running";
  }
  if ((status === "off" || status === "stopped") && instanceId) {
    return "stopped";
  }
  return undefined;
}

function fundingLaneForMode(
  fundingMode: AccountLocalDedicatedHostPolicySnapshot["funding_mode"],
): DedicatedHostFundingLane | undefined {
  switch (fundingMode) {
    case "account-prepaid":
      return "prepaid";
    case "account-postpaid":
      return "credit";
    default:
      return undefined;
  }
}

async function withMaintenanceLock<T>(
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return await withSessionAdvisoryLock({ lockKey: LOCK_KEY, fn });
}

async function listCandidateHosts(): Promise<CandidateHostRow[]> {
  const { rows } = await getPool().query<CandidateHostRow>(
    `
      SELECT id, name, region, status, metadata, maintenance
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

function pricingInputForHost({
  row,
  provider,
  billing_state,
}: {
  row: CandidateHostRow;
  provider: string;
  billing_state: DedicatedHostBillingState;
}) {
  const metadata = row.metadata ?? {};
  const machine = metadata.machine ?? {};
  return {
    provider,
    region: row.region,
    zone: machine.zone,
    machine_type: machine.machine_type ?? metadata.size,
    provider_platform: machine.metadata?.platform,
    disk_gb: machine.disk_gb,
    disk_type: machine.disk_type,
    shared_disk_gb: machine.shared_disk_gb,
    shared_disk_type: machine.shared_disk_type,
    storage_mode: machine.storage_mode,
    gpu_type: machine.gpu_type,
    gpu_count: machine.gpu_count,
    pricing_model: currentPricingModel(metadata),
    billing_state,
  } as const;
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
  const ownerSpendPolicy = retainedOwnerSpendPolicy(metadata);
  const started_at =
    typeof metadata?.billing?.started_at === "string"
      ? metadata.billing.started_at.trim()
      : "";
  return {
    funding_mode,
    ...(started_at ? { started_at } : {}),
    ...(enforcement ? { enforcement } : {}),
    ...ownerSpendPolicy,
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

function retainedOwnerSpendPolicy(metadata: any): any {
  const billing = metadata?.billing ?? {};
  return {
    ...(billing.owner_spend_limit_5h_usd != null
      ? { owner_spend_limit_5h_usd: billing.owner_spend_limit_5h_usd }
      : {}),
    ...(billing.owner_spend_limit_7d_usd != null
      ? { owner_spend_limit_7d_usd: billing.owner_spend_limit_7d_usd }
      : {}),
    ...(billing.owner_spend_limit_status != null
      ? { owner_spend_limit_status: billing.owner_spend_limit_status }
      : {}),
  };
}

function positiveLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function buildOwnerSpendLimitStatus({
  metadata,
  usage,
}: {
  metadata: any;
  usage: DedicatedHostOwnerWindowUsageSnapshot;
}): {
  state: "ok" | "at_risk" | "stopped_limit_exceeded";
  limit_5h_usd?: number;
  limit_7d_usd?: number;
  used_5h_usd: string;
  used_7d_usd: string;
  exceeded_window?: "5h" | "7d";
  first_exceeded_at?: string;
  stopped_at?: string;
  reason?: string;
} {
  const previous = metadata?.billing?.owner_spend_limit_status ?? {};
  const limit5h = positiveLimit(metadata?.billing?.owner_spend_limit_5h_usd);
  const limit7d = positiveLimit(metadata?.billing?.owner_spend_limit_7d_usd);
  const used5h = moneyToDbString(usage.spend_5h_usd);
  const used7d = moneyToDbString(usage.spend_7d_usd);
  const over5h = limit5h != null && toDecimal(used5h).gte(limit5h);
  const over7d = limit7d != null && toDecimal(used7d).gte(limit7d);
  const near5h = limit5h != null && toDecimal(used5h).gte(limit5h * 0.8);
  const near7d = limit7d != null && toDecimal(used7d).gte(limit7d * 0.8);
  const nowIso = new Date().toISOString();
  const exceeded_window = over5h ? "5h" : over7d ? "7d" : undefined;
  if (exceeded_window) {
    const limit = exceeded_window === "5h" ? limit5h : limit7d;
    return {
      state: "stopped_limit_exceeded",
      ...(limit5h != null ? { limit_5h_usd: limit5h } : {}),
      ...(limit7d != null ? { limit_7d_usd: limit7d } : {}),
      used_5h_usd: used5h,
      used_7d_usd: used7d,
      exceeded_window,
      first_exceeded_at: previous.first_exceeded_at ?? nowIso,
      stopped_at: previous.stopped_at,
      reason: `owner-configured ${exceeded_window} spend limit of $${limit} was reached`,
    };
  }
  return {
    state: near5h || near7d ? "at_risk" : "ok",
    ...(limit5h != null ? { limit_5h_usd: limit5h } : {}),
    ...(limit7d != null ? { limit_7d_usd: limit7d } : {}),
    used_5h_usd: used5h,
    used_7d_usd: used7d,
  };
}

function hasOwnerSpendLimit(metadata: any): boolean {
  return (
    positiveLimit(metadata?.billing?.owner_spend_limit_5h_usd) != null ||
    positiveLimit(metadata?.billing?.owner_spend_limit_7d_usd) != null
  );
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
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE project_hosts SET metadata=$2, updated=NOW()
      WHERE id=$1 AND deleted IS NULL${hostWriteGuard(2)}`,
    [host_id, metadata],
  );
  return (rowCount ?? 0) > 0;
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
  const { rowCount } = await getPool().query(
    `
      UPDATE project_hosts
      SET status=$2, last_seen=$3, metadata=$4, updated=NOW()
      WHERE id=$1 AND deleted IS NULL${hostWriteGuard(4)}
    `,
    [row.id, "stopping", null, metadata],
  );
  if (!rowCount) {
    logger.info("deferred dedicated host stop: host is being relocated", {
      host_id: row.id,
    });
    return;
  }
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

async function requestHostStopForOwnerSpendLimit({
  row,
  provider,
  ownerSpendStatus,
}: {
  row: CandidateHostRow;
  provider: string;
  ownerSpendStatus: ReturnType<typeof buildOwnerSpendLimitStatus>;
}): Promise<void> {
  const metadata = { ...(row.metadata ?? {}) };
  if (
    `${metadata?.desired_state ?? ""}`.trim().toLowerCase() === "stopped" &&
    `${row.status ?? ""}`.trim().toLowerCase() === "stopping"
  ) {
    return;
  }
  const billing = { ...(metadata.billing ?? {}) };
  const nowIso = new Date().toISOString();
  metadata.desired_state = "stopped";
  metadata.billing = {
    ...billing,
    owner_spend_limit_status: {
      ...ownerSpendStatus,
      stopped_at: ownerSpendStatus.stopped_at ?? nowIso,
    },
    stop_reason: ownerSpendStatus.reason,
    stop_requested_at: nowIso,
  };
  metadata.last_action = "stop";
  metadata.last_action_status = "pending";
  metadata.last_action_error = null;
  metadata.last_action_at = nowIso;
  const { rowCount } = await getPool().query(
    `
      UPDATE project_hosts
      SET status=$2, last_seen=$3, metadata=$4, updated=NOW()
      WHERE id=$1 AND deleted IS NULL${hostWriteGuard(4)}
    `,
    [row.id, "stopping", null, metadata],
  );
  if (!rowCount) {
    logger.info("deferred dedicated host stop: host is being relocated", {
      host_id: row.id,
    });
    return;
  }
  await enqueueCloudVmWork({
    vm_id: row.id,
    action: "stop",
    payload: { provider },
  });
  logger.warn("stopped dedicated host after owner spend cap was exceeded", {
    host_id: row.id,
    provider,
    exceeded_window: ownerSpendStatus.exceeded_window,
    reason: ownerSpendStatus.reason,
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

async function stoppedBillingBlockedEnforcement({
  row,
  decision,
  hourly_cost_usd,
}: {
  row: CandidateHostRow;
  decision: ReturnType<typeof evaluateDedicatedHostBillingEnforcement>;
  hourly_cost_usd: MoneyValue;
}): Promise<DedicatedHostBillingEnforcementMetadata> {
  const previous = currentEnforcement(row.metadata);
  const now = new Date();
  const nowIso = now.toISOString();
  const graceUntil =
    previous?.state === "stopped_billing_blocked" && previous.deprovision_after
      ? previous.deprovision_after
      : new Date(
          now.valueOf() + DEDICATED_HOST_BILLING_DISK_GRACE_HOURS * 3600_000,
        ).toISOString();
  const assignedProjects = await countProjectsAssignedToHost(row.id);
  const finalBackupStatus =
    previous?.final_backup_status === "succeeded" ||
    previous?.final_backup_status === "failed"
      ? previous.final_backup_status
      : assignedProjects === 0
        ? "succeeded"
        : "unknown";
  return {
    ...(previous ?? {}),
    state: "stopped_billing_blocked",
    reason_code: decision.reason_code,
    reason: decision.reason,
    first_detected_at: previous?.first_detected_at ?? nowIso,
    stopped_at: previous?.stopped_at ?? nowIso,
    grace_until: previous?.grace_until ?? graceUntil,
    deprovision_after: graceUntil,
    final_backup_status: finalBackupStatus,
    ...(finalBackupStatus === "succeeded"
      ? {
          final_backup_completed_at:
            previous?.final_backup_completed_at ?? nowIso,
        }
      : {}),
    recovery_actions: decision.recovery_actions,
    hourly_cost_usd,
    limiting_runway_hours: decision.limiting_runway_hours,
    limiting_window: decision.limiting_window,
  };
}

async function reconcileStoppedHost({
  row,
  owner,
  provider,
  snapshot,
}: {
  row: CandidateHostRow;
  owner: string;
  provider: string;
  snapshot: AccountLocalDedicatedHostPolicySnapshot;
}): Promise<void> {
  const metadata = row.metadata ?? {};
  const previousEnforcement = currentEnforcement(metadata);
  if (snapshot.funding_mode === "site-funded") {
    await closeDedicatedHostPurchaseSessionForAccount({
      account_id: owner,
      host_id: row.id,
    });
    const nextBilling = {
      funding_mode: "site-funded" as const,
      started_at: metadata?.billing?.started_at ?? new Date().toISOString(),
      ...retainedOwnerSpendPolicy(metadata),
    };
    if (
      JSON.stringify(nextBilling) !== JSON.stringify(metadata?.billing ?? {})
    ) {
      await updateHostBillingMetadata({
        host_id: row.id,
        metadata: { ...metadata, billing: nextBilling },
      });
    }
    if (previousEnforcement && previousEnforcement.state !== "ok") {
      await notifyBillingEnforcementTransition({
        row,
        owner,
        previous: previousEnforcement,
        next: { state: "ok" },
      });
    }
    return;
  }

  const catalogRate = await estimateDedicatedHostRate(
    pricingInputForHost({
      row,
      provider,
      billing_state: "stopped",
    }),
  );
  const rate =
    catalogRate ??
    dedicatedHostRateFromPricingSnapshot({
      pricing_snapshot: metadata?.billing?.pricing_snapshot,
      billing_state: "stopped",
    });
  if (!rate) {
    // Keep any existing purchase open rather than failing free while retained
    // provider disks continue to incur costs. Maintenance retries frequently.
    logger.error(
      "stopped dedicated-host pricing is unavailable; preserving billing session",
      {
        host_id: row.id,
        provider,
      },
    );
    try {
      await adminAlert({
        subject: `Stopped dedicated-host pricing unavailable: ${row.id}`,
        body: [
          `Host ID: ${row.id}`,
          `Host name: ${row.name}`,
          `Owner account ID: ${owner}`,
          `Provider: ${provider}`,
          "The existing purchase session was preserved. Check the cloud pricing catalog and host billing metadata.",
        ].join("\n"),
        dedupMinutes: 4 * 60,
        dedupBySubject: true,
      });
    } catch (err) {
      logger.error("failed to send stopped host pricing alert", {
        host_id: row.id,
        err: `${err}`,
      });
    }
    return;
  }
  if (toDecimal(rate.hourly_cost_usd).lte(0)) {
    await closeDedicatedHostPurchaseSessionForAccount({
      account_id: owner,
      host_id: row.id,
    });
    return;
  }

  const funding_lane =
    selectDedicatedHostFundingLane(snapshot) ??
    currentFundingLane(metadata) ??
    fundingLaneForMode(snapshot.funding_mode);
  if (!funding_lane) {
    await closeDedicatedHostPurchaseSessionForAccount({
      account_id: owner,
      host_id: row.id,
    });
    return;
  }

  await reconcileDedicatedHostPurchaseSessionForAccount({
    account_id: owner,
    host_id: row.id,
    resource_kind: "project-host",
    host_name: row.name ?? undefined,
    host_bay_id: getConfiguredBayId(),
    provider,
    region: row.region ?? undefined,
    billing_state: "stopped",
    funding_lane,
    hourly_cost_usd: rate.hourly_cost_usd,
    pricing_snapshot: rate.pricing_snapshot,
  });

  const laneAllowed = isDedicatedHostLaneCurrentlyAllowed({
    snapshot,
    funding_lane,
  });
  const decision = evaluateDedicatedHostBillingEnforcement({
    snapshot,
    funding_lane,
    hourly_cost_usd: rate.hourly_cost_usd,
    lane_allowed: laneAllowed,
  });
  const nextEnforcement =
    decision.action === "request_drain"
      ? await stoppedBillingBlockedEnforcement({
          row,
          decision,
          hourly_cost_usd: rate.hourly_cost_usd,
        })
      : buildDedicatedHostBillingEnforcementMetadata({
          previous: previousEnforcement,
          decision,
          hourly_cost_usd: rate.hourly_cost_usd,
        });
  const nextMetadata = {
    ...metadata,
    billing: {
      ...(metadata.billing ?? {}),
      funding_mode: snapshot.funding_mode,
      funding_lane,
      hourly_cost_usd: rate.hourly_cost_usd,
      pricing_snapshot: rate.pricing_snapshot,
      started_at: metadata?.billing?.started_at ?? new Date().toISOString(),
      ...retainedOwnerSpendPolicy(metadata),
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
    await notifyBillingEnforcementTransition({
      row,
      owner,
      previous: previousEnforcement,
      next: nextEnforcement,
    });
  }
  await maybeProgressInactiveEnforcement({
    row: { ...row, metadata: nextMetadata },
  });
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
      WHERE id=$1 AND deleted IS NULL${hostWriteGuard(3)}
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
      // Never let automated billing enforcement replace newer project data
      // with a stale backup. If the source is genuinely offline, preserve its
      // placement and disk until the host can be recovered or an operator
      // explicitly authorizes an offline move.
      allow_offline: false,
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

async function maybeSendDeprovisionReminder({
  row,
}: {
  row: CandidateHostRow;
}): Promise<boolean> {
  const metadata = row.metadata ?? {};
  const enforcement = currentEnforcement(metadata);
  if (
    enforcement?.state !== "stopped_billing_blocked" ||
    enforcement.final_backup_status !== "succeeded" ||
    enforcement.deprovision_reminder_sent_at ||
    !enforcement.deprovision_after
  ) {
    return false;
  }
  const deprovisionAfter = new Date(enforcement.deprovision_after).getTime();
  const now = Date.now();
  if (
    !Number.isFinite(deprovisionAfter) ||
    deprovisionAfter <= now ||
    deprovisionAfter - now > DEPROVISION_REMINDER_LEAD_MS
  ) {
    return false;
  }
  const owner = `${metadata?.owner ?? ""}`.trim();
  if (!owner) return false;
  const sent = await notifyDedicatedHostDeprovisionReminderBestEffort({
    owner_account_id: owner,
    host_id: row.id,
    host_name: row.name,
    deprovision_after: enforcement.deprovision_after,
  });
  if (!sent) return false;
  await updateHostBillingMetadata({
    host_id: row.id,
    metadata: {
      ...metadata,
      billing: {
        ...(metadata.billing ?? {}),
        enforcement: {
          ...enforcement,
          deprovision_reminder_sent_at: new Date().toISOString(),
        },
      },
    },
  });
  return true;
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
  if (await maybeSendDeprovisionReminder({ row })) {
    return true;
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
  const rate = await estimateDedicatedHostRate({
    provider,
    region: row.region,
    zone: machine.zone,
    machine_type: machine.machine_type ?? metadata?.size,
    provider_platform: machine.metadata?.platform,
    disk_gb: machine.disk_gb,
    disk_type: machine.disk_type,
    shared_disk_gb: machine.shared_disk_gb,
    shared_disk_type: machine.shared_disk_type,
    storage_mode: machine.storage_mode,
    gpu_type: machine.gpu_type,
    gpu_count: machine.gpu_count,
    pricing_model: currentPricingModel(metadata),
    billing_state: "running",
  });
  if (!rate) return false;

  const nextEnforcement = { state: "ok" as const };
  await updateHostBillingMetadata({
    host_id: row.id,
    metadata: {
      ...metadata,
      billing: {
        ...(metadata.billing ?? {}),
        funding_mode: effectiveSnapshot.funding_mode,
        funding_lane,
        hourly_cost_usd: rate.hourly_cost_usd,
        pricing_snapshot: rate.pricing_snapshot,
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

  const getSnapshot = async (
    account_id: string,
    funding_mode_override?:
      "account-prepaid" | "account-postpaid" | "site-funded",
  ) => {
    const cacheKey = `${account_id}:${funding_mode_override ?? ""}`;
    const cached = snapshotCache.get(cacheKey);
    if (cached) return cached;
    const snapshot = await getDedicatedHostPolicySnapshotForAccount({
      account_id,
      funding_mode_override,
    });
    snapshotCache.set(cacheKey, snapshot);
    return snapshot;
  };
  const deleteSnapshotCacheForAccount = (account_id: string) => {
    for (const key of snapshotCache.keys()) {
      if (key === account_id || key.startsWith(`${account_id}:`)) {
        snapshotCache.delete(key);
      }
    }
  };

  for (const row of rows) {
    // A relocation owns the host; enforcement resumes on the first pass after
    // it releases the host.
    if (hostLifecycleFenced(row.maintenance)) {
      logger.debug("skipping host being relocated", { host_id: row.id });
      continue;
    }
    const metadata = row.metadata ?? {};
    const owner = `${metadata?.owner ?? ""}`.trim();
    const machine = metadata?.machine ?? {};
    const provider = normalizeProviderId(machine.cloud);
    if (!owner || !provider || !isBillableDedicatedHostCloud(provider)) {
      continue;
    }

    const status = `${row.status ?? ""}`.trim().toLowerCase();
    const billingState = billingStateForHost(row);
    if (!billingState) {
      const fundingMode = currentFundingMode(metadata);
      await closeDedicatedHostPurchaseSessionForAccount({
        account_id: owner,
        host_id: row.id,
      });
      if (
        await maybeClearRecoveredInactiveEnforcement({
          row,
          provider,
          snapshot: await getSnapshot(owner, fundingMode),
        })
      ) {
        deleteSnapshotCacheForAccount(owner);
        continue;
      }
      if (await maybeProgressInactiveEnforcement({ row })) {
        deleteSnapshotCacheForAccount(owner);
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
      deleteSnapshotCacheForAccount(owner);
      continue;
    }

    if (billingState === "stopped") {
      const snapshot = applyDedicatedHostFundingModeOverride(
        await getSnapshot(owner, currentFundingMode(metadata)),
        currentFundingMode(metadata),
      );
      await reconcileStoppedHost({
        row,
        owner,
        provider,
        snapshot,
      });
      deleteSnapshotCacheForAccount(owner);
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
      deleteSnapshotCacheForAccount(owner);
      continue;
    }

    const snapshot = applyDedicatedHostFundingModeOverride(
      await getSnapshot(owner, currentFundingMode(metadata)),
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
        ...retainedOwnerSpendPolicy(metadata),
      };
      if (
        JSON.stringify(nextBilling) !== JSON.stringify(metadata?.billing ?? {})
      ) {
        await updateHostBillingMetadata({
          host_id: row.id,
          metadata: { ...metadata, billing: nextBilling },
        });
      }
      deleteSnapshotCacheForAccount(owner);
      continue;
    }

    const pricing_model = currentPricingModel(metadata);
    const rate = await estimateDedicatedHostRate(
      pricingInputForHost({
        row,
        provider,
        billing_state: "running",
      }),
    );
    if (!rate || toDecimal(rate.hourly_cost_usd).lte(0)) {
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
      resource_kind: "project-host",
      host_name: row.name ?? undefined,
      host_bay_id: getConfiguredBayId(),
      provider,
      region: row.region ?? undefined,
      billing_state: "running",
      machine_type: machine.machine_type ?? metadata?.size,
      pricing_model,
      funding_lane,
      hourly_cost_usd: rate.hourly_cost_usd,
      pricing_snapshot: rate.pricing_snapshot,
    });

    deleteSnapshotCacheForAccount(owner);
    if (status === "stopping") {
      await updateHostBillingMetadata({
        host_id: row.id,
        metadata: {
          ...metadata,
          billing: {
            ...(metadata.billing ?? {}),
            funding_mode: snapshot.funding_mode,
            funding_lane,
            hourly_cost_usd: rate.hourly_cost_usd,
            pricing_snapshot: rate.pricing_snapshot,
            started_at: preserveStartedAt ?? new Date().toISOString(),
            ...retainedOwnerSpendPolicy(metadata),
          },
        },
      });
      continue;
    }
    const refreshedFundingMode = currentFundingMode({
      ...metadata,
      billing: {
        ...(metadata.billing ?? {}),
        funding_mode: snapshot.funding_mode,
        funding_lane,
      },
    });
    const refreshedSnapshot = applyDedicatedHostFundingModeOverride(
      await getSnapshot(owner, refreshedFundingMode),
      refreshedFundingMode,
    );
    const laneAllowed = isDedicatedHostLaneCurrentlyAllowed({
      snapshot: refreshedSnapshot,
      funding_lane,
    });
    const ownerSpendUsage = hasOwnerSpendLimit(metadata)
      ? await getDedicatedHostWindowUsageForHostLocal({
          account_id: owner,
          host_id: row.id,
        })
      : undefined;
    const ownerSpendStatus = ownerSpendUsage
      ? buildOwnerSpendLimitStatus({
          metadata,
          usage: ownerSpendUsage,
        })
      : undefined;
    if (ownerSpendStatus?.state === "stopped_limit_exceeded") {
      await requestHostStopForOwnerSpendLimit({
        row: {
          ...row,
          metadata: {
            ...metadata,
            billing: {
              ...(metadata.billing ?? {}),
              funding_mode: snapshot.funding_mode,
              funding_lane,
              hourly_cost_usd: rate.hourly_cost_usd,
              pricing_snapshot: rate.pricing_snapshot,
              started_at: preserveStartedAt ?? new Date().toISOString(),
              ...retainedOwnerSpendPolicy(metadata),
              owner_spend_limit_status: ownerSpendStatus,
            },
          },
        },
        provider,
        ownerSpendStatus,
      });
      deleteSnapshotCacheForAccount(owner);
      continue;
    }
    const enforcementDecision = evaluateDedicatedHostBillingEnforcement({
      snapshot: refreshedSnapshot,
      funding_lane,
      hourly_cost_usd: rate.hourly_cost_usd,
      lane_allowed: laneAllowed,
    });
    const nextEnforcement = buildDedicatedHostBillingEnforcementMetadata({
      previous: currentEnforcement(metadata),
      decision: enforcementDecision,
      hourly_cost_usd: rate.hourly_cost_usd,
    });

    const nextMetadata = {
      ...metadata,
      billing: {
        funding_mode: snapshot.funding_mode,
        funding_lane,
        hourly_cost_usd: rate.hourly_cost_usd,
        pricing_snapshot: rate.pricing_snapshot,
        started_at: preserveStartedAt ?? new Date().toISOString(),
        ...retainedOwnerSpendPolicy(metadata),
        ...(ownerSpendStatus
          ? { owner_spend_limit_status: ownerSpendStatus }
          : {}),
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
    deleteSnapshotCacheForAccount(owner);
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
