/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Automatic runtime deployment queue helpers for hosts.

What belongs here:

- deciding whether a running host needs an automatic runtime reconcile or
  artifact upgrade enqueue
- creating the corresponding host LRO inputs once status has been observed
- best-effort queue fanout across a list of host ids

What does not belong here:

- loading account-owned host rows for normal API handlers
- status observation internals
- runtime deployment mutation
- actual reconcile / rollback execution

This keeps the automatic queueing logic readable on its own while `hosts.ts`
continues to own the surrounding API surface and dependency wiring.
*/

import type {
  HostLroKind,
  HostSoftwareUpgradeTarget,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";

type AutomaticQueueSkipReason =
  | "host_missing"
  | "host_not_running"
  | "no_reconcile_needed"
  | "observation_failed";

type RuntimeReconcileQueued =
  | {
      queued: false;
      host_id: string;
      reason: AutomaticQueueSkipReason;
      observation_error?: string;
    }
  | {
      queued: true;
      host_id: string;
      components: ManagedComponentKind[];
      op_id: string;
    };

type ArtifactReconcileQueued =
  | {
      queued: false;
      host_id: string;
      reason: AutomaticQueueSkipReason;
      observation_error?: string;
    }
  | {
      queued: true;
      host_id: string;
      targets: HostSoftwareUpgradeTarget[];
      op_id: string;
    };

function timestampMs(value?: string): number {
  const ts = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(ts) ? ts : 0;
}

function pickRequestedBy({
  row,
  deployments,
}: {
  row: any;
  deployments: Array<{
    requested_by?: string;
    updated_at?: string;
    requested_at?: string;
  }>;
}): string | undefined {
  const candidate = [...(deployments ?? [])]
    .filter((deployment) => `${deployment?.requested_by ?? ""}`.trim())
    .sort((a, b) => {
      const aTs = Math.max(
        timestampMs(a.updated_at),
        timestampMs(a.requested_at),
      );
      const bTs = Math.max(
        timestampMs(b.updated_at),
        timestampMs(b.requested_at),
      );
      return bTs - aTs;
    })[0];
  return (
    `${candidate?.requested_by ?? ""}`.trim() ||
    `${row?.metadata?.owner ?? ""}`.trim() ||
    undefined
  );
}

function uniqueHostIds(host_ids: string[]): string[] {
  return Array.from(
    new Set(
      (host_ids ?? [])
        .map((host_id) => `${host_id ?? ""}`.trim())
        .filter((host_id) => host_id.length > 0),
    ),
  );
}

export async function ensureAutomaticHostRuntimeDeploymentsReconcileInternal({
  host_id,
  reason,
  running_statuses,
  loadHostRowForRuntimeDeploymentsInternal,
  getHostRuntimeDeploymentStatusInternal,
  computeHostRuntimeDeploymentReconcilePlan,
  createHostLro,
  normalizeManagedComponentKindsForDedupe,
  reconcile_lro_kind,
  automatic_reason,
}: {
  host_id: string;
  reason?: string;
  running_statuses: Set<string>;
  loadHostRowForRuntimeDeploymentsInternal: (
    host_id: string,
  ) => Promise<any | undefined>;
  getHostRuntimeDeploymentStatusInternal: (opts: {
    id: string;
    row: any;
  }) => Promise<any>;
  computeHostRuntimeDeploymentReconcilePlan: (opts: {
    row: any;
    status: any;
    components?: ManagedComponentKind[];
  }) => {
    reconciled_components: ManagedComponentKind[];
  };
  createHostLro: (opts: {
    kind: HostLroKind;
    row: any;
    account_id?: string;
    input: any;
    dedupe_key: string;
  }) => Promise<{ op_id: string }>;
  normalizeManagedComponentKindsForDedupe: (
    components: ManagedComponentKind[],
  ) => ManagedComponentKind[];
  reconcile_lro_kind: HostLroKind;
  automatic_reason: string;
}): Promise<RuntimeReconcileQueued> {
  const row = await loadHostRowForRuntimeDeploymentsInternal(host_id);
  if (!row) {
    return { queued: false, host_id, reason: "host_missing" };
  }
  if (!running_statuses.has(`${row?.status ?? ""}`.toLowerCase())) {
    return { queued: false, host_id: row.id, reason: "host_not_running" };
  }
  const status = await getHostRuntimeDeploymentStatusInternal({
    id: row.id,
    row,
  });
  if (status.observation_error && !(status.observed_components ?? []).length) {
    return {
      queued: false,
      host_id: row.id,
      reason: "observation_failed",
      observation_error: status.observation_error,
    };
  }
  const plan = computeHostRuntimeDeploymentReconcilePlan({
    row,
    status,
  });
  if (!plan.reconciled_components.length) {
    return { queued: false, host_id: row.id, reason: "no_reconcile_needed" };
  }
  const requestedBy = pickRequestedBy({
    row,
    deployments: (status.effective ?? []).filter(
      (deployment: any) =>
        deployment?.target_type === "component" &&
        plan.reconciled_components.includes(
          deployment.target as ManagedComponentKind,
        ),
    ),
  });
  const op = await createHostLro({
    kind: reconcile_lro_kind,
    row,
    account_id: requestedBy,
    input: {
      id: row.id,
      ...(requestedBy ? { account_id: requestedBy } : {}),
      components: plan.reconciled_components,
      reason: reason ?? automatic_reason,
    },
    dedupe_key: `${reconcile_lro_kind}:${row.id}:${JSON.stringify({
      components: normalizeManagedComponentKindsForDedupe(
        plan.reconciled_components,
      ),
      reason: `${reason ?? automatic_reason}`.trim() || null,
    })}`,
  });
  return {
    queued: true,
    host_id: row.id,
    components: plan.reconciled_components,
    op_id: op.op_id,
  };
}

export async function ensureAutomaticHostArtifactDeploymentsReconcileInternal({
  host_id,
  running_statuses,
  loadHostRowForRuntimeDeploymentsInternal,
  getHostRuntimeDeploymentStatusInternal,
  computeAutomaticArtifactUpgradeTargets,
  createHostLro,
  hostUpgradeDedupeKey,
  upgrade_lro_kind,
}: {
  host_id: string;
  running_statuses: Set<string>;
  loadHostRowForRuntimeDeploymentsInternal: (
    host_id: string,
  ) => Promise<any | undefined>;
  getHostRuntimeDeploymentStatusInternal: (opts: {
    id: string;
    row: any;
  }) => Promise<any>;
  computeAutomaticArtifactUpgradeTargets: (opts: {
    status: any;
  }) => HostSoftwareUpgradeTarget[];
  createHostLro: (opts: {
    kind: HostLroKind;
    row: any;
    account_id?: string;
    input: any;
    dedupe_key: string;
  }) => Promise<{ op_id: string }>;
  hostUpgradeDedupeKey: (opts: {
    hostId: string;
    targets: HostSoftwareUpgradeTarget[];
  }) => string;
  upgrade_lro_kind: HostLroKind;
}): Promise<ArtifactReconcileQueued> {
  const row = await loadHostRowForRuntimeDeploymentsInternal(host_id);
  if (!row) {
    return { queued: false, host_id, reason: "host_missing" };
  }
  if (!running_statuses.has(`${row?.status ?? ""}`.toLowerCase())) {
    return { queued: false, host_id: row.id, reason: "host_not_running" };
  }
  const status = await getHostRuntimeDeploymentStatusInternal({
    id: row.id,
    row,
  });
  if (status.observation_error && !(status.observed_artifacts ?? []).length) {
    return {
      queued: false,
      host_id: row.id,
      reason: "observation_failed",
      observation_error: status.observation_error,
    };
  }
  const targets = computeAutomaticArtifactUpgradeTargets({ status });
  if (!targets.length) {
    return { queued: false, host_id: row.id, reason: "no_reconcile_needed" };
  }
  const requestedBy = pickRequestedBy({
    row,
    deployments: (status.effective ?? []).filter(
      (deployment: any) =>
        deployment?.target_type === "artifact" &&
        targets.some(
          (target) =>
            deployment.target === target.artifact &&
            deployment.desired_version === target.version,
        ),
    ),
  });
  const op = await createHostLro({
    kind: upgrade_lro_kind,
    row,
    account_id: requestedBy,
    input: {
      id: row.id,
      ...(requestedBy ? { account_id: requestedBy } : {}),
      targets,
    },
    dedupe_key: hostUpgradeDedupeKey({
      hostId: row.id,
      targets,
    }),
  });
  return {
    queued: true,
    host_id: row.id,
    targets,
    op_id: op.op_id,
  };
}

export async function bestEffortQueueAutomaticRuntimeDeploymentReconcileForHostsInternal({
  host_ids,
  reason,
  ensureAutomaticHostRuntimeDeploymentsReconcile,
  logWarn,
}: {
  host_ids: string[];
  reason?: string;
  ensureAutomaticHostRuntimeDeploymentsReconcile: (opts: {
    host_id: string;
    reason?: string;
  }) => Promise<RuntimeReconcileQueued>;
  logWarn: (message: string, payload: Record<string, any>) => void;
}): Promise<void> {
  const normalizedHostIds = uniqueHostIds(host_ids);
  if (!normalizedHostIds.length) return;
  const settled = await Promise.allSettled(
    normalizedHostIds.map((host_id) =>
      ensureAutomaticHostRuntimeDeploymentsReconcile({ host_id, reason }),
    ),
  );
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn("automatic runtime deployment reconcile enqueue failed", {
        host_id: normalizedHostIds[index],
        reason: `${result.reason}`,
      });
    }
  });
}

export async function bestEffortQueueAutomaticArtifactDeploymentReconcileForHostsInternal({
  host_ids,
  ensureAutomaticHostArtifactDeploymentsReconcile,
  logWarn,
}: {
  host_ids: string[];
  ensureAutomaticHostArtifactDeploymentsReconcile: (opts: {
    host_id: string;
  }) => Promise<ArtifactReconcileQueued>;
  logWarn: (message: string, payload: Record<string, any>) => void;
}): Promise<void> {
  const normalizedHostIds = uniqueHostIds(host_ids);
  if (!normalizedHostIds.length) return;
  const settled = await Promise.allSettled(
    normalizedHostIds.map((host_id) =>
      ensureAutomaticHostArtifactDeploymentsReconcile({ host_id }),
    ),
  );
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      logWarn("automatic artifact deployment reconcile enqueue failed", {
        host_id: normalizedHostIds[index],
        reason: `${result.reason}`,
      });
    }
  });
}
