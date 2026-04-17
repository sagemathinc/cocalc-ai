/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Runtime deployment execution helpers for hosts.

What belongs here:

- side-effecting runtime deployment reconcile execution once the caller has
  already chosen to run it
- side-effecting runtime deployment rollback execution once the caller has
  already resolved the target and authorization context

What does not belong here:

- public API handler entrypoints
- LRO enqueue decisions
- read-only status observation
- generic host lifecycle helpers

`hosts.ts` keeps the public wrappers and dependency wiring while this file
contains the execution flow itself.
*/

import type {
  HostRuntimeDeploymentReconcileResult,
  HostRuntimeDeploymentRollbackResult,
  HostRuntimeDeploymentTarget,
  HostRuntimeDeploymentRecord,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";

export async function reconcileHostRuntimeDeploymentsInternalHelper({
  account_id,
  id,
  components,
  reason,
  loadHostForStartStop,
  assertHostRunningForUpgrade,
  getHostRuntimeDeploymentStatus,
  computeHostRuntimeDeploymentReconcilePlan,
  rolloutHostManagedComponentsInternal,
}: {
  account_id?: string;
  id: string;
  components?: ManagedComponentKind[];
  reason?: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  assertHostRunningForUpgrade: (row: any) => void;
  getHostRuntimeDeploymentStatus: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<any>;
  computeHostRuntimeDeploymentReconcilePlan: (opts: {
    row: any;
    status: any;
    components?: ManagedComponentKind[];
  }) => Pick<
    HostRuntimeDeploymentReconcileResult,
    "requested_components" | "reconciled_components" | "decisions"
  >;
  rolloutHostManagedComponentsInternal: (opts: {
    account_id?: string;
    id: string;
    components: ManagedComponentKind[];
    reason?: string;
  }) => Promise<{
    results?: HostRuntimeDeploymentReconcileResult["rollout_results"];
  }>;
}): Promise<HostRuntimeDeploymentReconcileResult> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const status = await getHostRuntimeDeploymentStatus({ account_id, id });
  const plan = computeHostRuntimeDeploymentReconcilePlan({
    row,
    status,
    components,
  });

  const result: HostRuntimeDeploymentReconcileResult = {
    host_id: row.id,
    ...plan,
  };
  if (!plan.reconciled_components.length) {
    return result;
  }
  const rollout = await rolloutHostManagedComponentsInternal({
    account_id,
    id,
    components: plan.reconciled_components,
    reason,
  });
  return {
    ...result,
    rollout_results: rollout.results ?? [],
  };
}

export async function rollbackHostRuntimeDeploymentsInternalHelper({
  account_id,
  id,
  target_type,
  target,
  version,
  last_known_good,
  reason,
  loadHostForStartStop,
  assertHostRunningForUpgrade,
  getHostRuntimeDeploymentStatus,
  targetKeyForRuntimeDeployment,
  resolveRollbackVersion,
  requestedByForRuntimeDeployments,
  setProjectHostRuntimeDeployments,
  upgradeHostSoftwareInternal,
  reconcileProjectHostComponent,
  rolloutProjectHostArtifact,
}: {
  account_id?: string;
  id: string;
  target_type: "component" | "artifact";
  target: HostRuntimeDeploymentTarget;
  version?: string;
  last_known_good?: boolean;
  reason?: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  assertHostRunningForUpgrade: (row: any) => void;
  getHostRuntimeDeploymentStatus: (opts: {
    account_id?: string;
    id: string;
  }) => Promise<any>;
  targetKeyForRuntimeDeployment: (opts: {
    target_type: HostRuntimeDeploymentRecord["target_type"];
    target: HostRuntimeDeploymentRecord["target"];
  }) => string;
  resolveRollbackVersion: (opts: {
    rollbackTarget: any;
    version?: string;
    last_known_good?: boolean;
  }) => {
    rollback_version: string;
    rollback_source: HostRuntimeDeploymentRollbackResult["rollback_source"];
  };
  requestedByForRuntimeDeployments: (opts: {
    account_id?: string;
    row: any;
  }) => string;
  setProjectHostRuntimeDeployments: (opts: {
    scope_type: "host";
    host_id: string;
    requested_by: string;
    replace: boolean;
    deployments: any[];
  }) => Promise<HostRuntimeDeploymentRecord[]>;
  upgradeHostSoftwareInternal: (opts: {
    account_id?: string;
    id: string;
    targets: Array<{ artifact: any; version: string }>;
  }) => Promise<{
    results?: HostRuntimeDeploymentRollbackResult["upgrade_results"];
  }>;
  reconcileProjectHostComponent: (opts: {
    account_id?: string;
    id: string;
    component: ManagedComponentKind;
    reason?: string;
  }) => Promise<HostRuntimeDeploymentRollbackResult["reconcile_result"]>;
  rolloutProjectHostArtifact: (opts: {
    account_id?: string;
    id: string;
    reason?: string;
  }) => Promise<
    HostRuntimeDeploymentRollbackResult["managed_component_rollout"]
  >;
}): Promise<HostRuntimeDeploymentRollbackResult> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const status = await getHostRuntimeDeploymentStatus({ account_id, id });
  const effectiveTargets = new Map(
    (status.effective ?? []).map((deployment: HostRuntimeDeploymentRecord) => [
      targetKeyForRuntimeDeployment({
        target_type: deployment.target_type,
        target: deployment.target,
      }),
      deployment,
    ]),
  );
  const rollbackTargets = new Map(
    (status.rollback_targets ?? []).map((rollbackTarget: any) => [
      targetKeyForRuntimeDeployment({
        target_type: rollbackTarget.target_type,
        target: rollbackTarget.target,
      }),
      rollbackTarget,
    ]),
  );
  const key = targetKeyForRuntimeDeployment({ target_type, target });
  const deployment = effectiveTargets.get(key) as
    | HostRuntimeDeploymentRecord
    | undefined;
  const rollbackTarget = rollbackTargets.get(key) as any;
  if (!deployment || !rollbackTarget) {
    throw new Error("rollback target is not configured");
  }
  const { rollback_version, rollback_source } = resolveRollbackVersion({
    rollbackTarget,
    version,
    last_known_good,
  });
  const artifact = rollbackTarget.artifact;
  if (artifact === "bootstrap-environment") {
    throw new Error("bootstrap-environment rollback is not implemented");
  }
  const requested_by = requestedByForRuntimeDeployments({ account_id, row });
  const updatedDeployments = await setProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
    requested_by,
    replace: false,
    deployments: [
      {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: rollback_version,
        rollout_policy: deployment.rollout_policy,
        drain_deadline_seconds: deployment.drain_deadline_seconds,
        rollout_reason:
          `${reason ?? deployment.rollout_reason ?? ""}`.trim() || undefined,
        metadata: deployment.metadata,
      },
    ],
  });
  const updatedDeployment = updatedDeployments.find(
    (entry) => entry.target_type === target_type && entry.target === target,
  );
  let upgrade_results: HostRuntimeDeploymentRollbackResult["upgrade_results"];
  let reconcile_result:
    | HostRuntimeDeploymentRollbackResult["reconcile_result"]
    | undefined;
  let managed_component_rollout:
    | HostRuntimeDeploymentRollbackResult["managed_component_rollout"]
    | undefined;
  const currentArtifactVersion =
    `${rollbackTarget.current_version ?? ""}`.trim();
  if (currentArtifactVersion !== rollback_version) {
    const upgrade = await upgradeHostSoftwareInternal({
      account_id,
      id: row.id,
      targets: [{ artifact, version: rollback_version }],
    });
    upgrade_results = upgrade.results ?? [];
  }
  if (target_type === "artifact") {
    if (
      target === "project-host" &&
      currentArtifactVersion !== rollback_version
    ) {
      managed_component_rollout = await rolloutProjectHostArtifact({
        account_id,
        id: row.id,
        reason: reason ?? "runtime_rollback",
      });
    }
  } else {
    if (artifact !== "project-host") {
      throw new Error(`component rollback for ${artifact} is not implemented`);
    }
    reconcile_result = await reconcileProjectHostComponent({
      account_id,
      id: row.id,
      component: target as ManagedComponentKind,
      reason: reason ?? "runtime_rollback",
    });
  }
  return {
    host_id: row.id,
    target_type,
    target,
    artifact,
    rollback_version,
    rollback_source,
    deployment: updatedDeployment,
    ...(upgrade_results ? { upgrade_results } : {}),
    ...(reconcile_result ? { reconcile_result } : {}),
    ...(managed_component_rollout ? { managed_component_rollout } : {}),
  };
}
