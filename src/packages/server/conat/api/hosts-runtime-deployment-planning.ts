/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Runtime deployment normalization and planning helpers for hosts.

What belongs here:

- pure normalization of runtime deployment targets and upserts
- helper logic that computes reconcile decisions and automatic artifact
  upgrade targets from already-fetched host runtime status
- helper code that maps upgrade / rollout results back into runtime
  deployment upserts

What does not belong here:

- database reads or writes
- host control RPCs
- LRO creation or orchestration
- any reconcile / rollback side effects

This keeps the deploy-plan logic readable in one place while `hosts.ts`
continues to own the operational flow that executes those plans.
*/

import type {
  HostRuntimeArtifact,
  HostRuntimeDeploymentReconcileResult,
  HostRuntimeDeploymentStatus,
  HostRuntimeDeploymentUpsert,
  HostSoftwareArtifact,
  HostSoftwareUpgradeResponse,
  HostSoftwareUpgradeTarget,
} from "@cocalc/conat/hub/api/hosts";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";
import { normalizeManagedComponentKindsForDedupe } from "./hosts-software";
import { installedProjectHostArtifactVersion } from "./hosts-runtime-observation";

export const DEFAULT_RUNTIME_DEPLOYMENT_POLICY: Record<
  ManagedComponentKind,
  HostRuntimeDeploymentUpsert["rollout_policy"]
> = {
  "project-host": "restart_now",
  "conat-router": "restart_now",
  "conat-persist": "restart_now",
  "acp-worker": "drain_then_replace",
};

const PROJECT_HOST_RUNTIME_STACK_COMPONENTS: ManagedComponentKind[] = [
  "project-host",
  "conat-router",
  "conat-persist",
  "acp-worker",
];

export function runtimeDeploymentsForAlignedProjectHostVersion({
  version,
  rolloutReason = "project_host_upgrade",
}: {
  version?: string;
  rolloutReason?: string;
}): HostRuntimeDeploymentUpsert[] {
  const desiredVersion = `${version ?? ""}`.trim();
  if (!desiredVersion) return [];
  return normalizeRuntimeDeploymentUpserts([
    {
      target_type: "artifact",
      target: "project-host",
      desired_version: desiredVersion,
    },
    ...PROJECT_HOST_RUNTIME_STACK_COMPONENTS.map((component) => ({
      target_type: "component" as const,
      target: component,
      desired_version: desiredVersion,
      rollout_policy: DEFAULT_RUNTIME_DEPLOYMENT_POLICY[component],
      rollout_reason: rolloutReason,
    })),
  ]);
}

export function normalizeRuntimeArtifactTarget(
  artifact?: HostSoftwareArtifact | HostRuntimeArtifact,
): HostRuntimeArtifact | undefined {
  if (artifact === "project" || artifact === "project-bundle") {
    return "project-bundle";
  }
  if (
    artifact === "project-host" ||
    artifact === "tools" ||
    artifact === "bootstrap-environment"
  ) {
    return artifact;
  }
  return;
}

function normalizeRuntimeDeploymentUpsert(
  deployment: HostRuntimeDeploymentUpsert,
): HostRuntimeDeploymentUpsert | undefined {
  const desired_version = `${deployment?.desired_version ?? ""}`.trim();
  if (!desired_version) return;
  if (deployment?.target_type === "component") {
    const target = deployment.target as ManagedComponentKind;
    if (!(target in DEFAULT_RUNTIME_DEPLOYMENT_POLICY)) return;
    return {
      ...deployment,
      target_type: "component",
      target,
      desired_version,
      rollout_policy:
        deployment.rollout_policy ?? DEFAULT_RUNTIME_DEPLOYMENT_POLICY[target],
      rollout_reason: `${deployment?.rollout_reason ?? ""}`.trim() || undefined,
      drain_deadline_seconds:
        deployment.drain_deadline_seconds == null
          ? undefined
          : Math.max(0, Math.floor(Number(deployment.drain_deadline_seconds))),
      metadata:
        deployment.metadata && typeof deployment.metadata === "object"
          ? deployment.metadata
          : undefined,
    };
  }
  if (deployment?.target_type === "artifact") {
    const target = normalizeRuntimeArtifactTarget(
      deployment.target as HostRuntimeArtifact,
    );
    if (!target) return;
    return {
      ...deployment,
      target_type: "artifact",
      target,
      desired_version,
      rollout_policy: deployment.rollout_policy,
      rollout_reason: `${deployment?.rollout_reason ?? ""}`.trim() || undefined,
      drain_deadline_seconds:
        deployment.drain_deadline_seconds == null
          ? undefined
          : Math.max(0, Math.floor(Number(deployment.drain_deadline_seconds))),
      metadata:
        deployment.metadata && typeof deployment.metadata === "object"
          ? deployment.metadata
          : undefined,
    };
  }
  return;
}

export function normalizeRuntimeDeploymentUpserts(
  deployments: HostRuntimeDeploymentUpsert[],
): HostRuntimeDeploymentUpsert[] {
  const deduped = new Map<string, HostRuntimeDeploymentUpsert>();
  for (const deployment of deployments ?? []) {
    const normalized = normalizeRuntimeDeploymentUpsert(deployment);
    if (!normalized) continue;
    deduped.set(`${normalized.target_type}:${normalized.target}`, normalized);
  }
  return [...deduped.values()];
}

export function computeAutomaticArtifactUpgradeTargets({
  status,
}: {
  status: HostRuntimeDeploymentStatus;
}): HostSoftwareUpgradeTarget[] {
  const observedTargets = new Map(
    (status.observed_targets ?? [])
      .filter((target) => target.target_type === "artifact")
      .map((target) => [target.target as HostRuntimeArtifact, target]),
  );
  const targets: HostSoftwareUpgradeTarget[] = [];
  for (const deployment of status.effective ?? []) {
    if (deployment.target_type !== "artifact") continue;
    const target = deployment.target as HostRuntimeArtifact;
    if (target === "project-host" || target === "bootstrap-environment") {
      continue;
    }
    const observed = observedTargets.get(target);
    const observedState = observed?.observed_version_state;
    if (observedState === "aligned" || observedState === "unsupported") {
      continue;
    }
    targets.push({
      artifact: target,
      version: deployment.desired_version,
    });
  }
  return targets;
}

export function computeHostRuntimeDeploymentReconcilePlan({
  row,
  status,
  components,
}: {
  row: any;
  status: HostRuntimeDeploymentStatus;
  components?: ManagedComponentKind[];
}): Pick<
  HostRuntimeDeploymentReconcileResult,
  "requested_components" | "reconciled_components" | "decisions"
> {
  const effectiveComponentTargets = new Map(
    (status.effective ?? [])
      .filter(
        (deployment) =>
          deployment.target_type === "component" &&
          DEFAULT_RUNTIME_DEPLOYMENT_POLICY[
            deployment.target as ManagedComponentKind
          ] != null,
      )
      .map((deployment) => [
        deployment.target as ManagedComponentKind,
        deployment,
      ]),
  );
  const observedComponents = new Map(
    (status.observed_components ?? []).map((component) => [
      component.component,
      component,
    ]),
  );
  const observedTargets = new Map(
    (status.observed_targets ?? [])
      .filter((target) => target.target_type === "component")
      .map((target) => [target.target as ManagedComponentKind, target]),
  );
  const requestedComponents = (components ?? []).length
    ? normalizeManagedComponentKindsForDedupe(components ?? [])
    : [...effectiveComponentTargets.keys()].sort();
  const currentArtifactVersion = installedProjectHostArtifactVersion(row);
  const decisions: HostRuntimeDeploymentReconcileResult["decisions"] = [];
  const reconciled_components: ManagedComponentKind[] = [];

  for (const component of requestedComponents) {
    const deployment = effectiveComponentTargets.get(component);
    if (!deployment) {
      decisions.push({
        component,
        decision: "skip",
        reason: "no_desired_component_target",
      });
      continue;
    }
    const observed = observedComponents.get(component);
    const observedTarget = observedTargets.get(component);
    const artifact = `${observed?.artifact ?? "project-host"}`.trim();
    if (!observed) {
      decisions.push({
        component,
        decision: "skip",
        reason: "unobserved_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!observed.managed) {
      decisions.push({
        component,
        decision: "skip",
        reason: "unmanaged_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!observed.enabled) {
      decisions.push({
        component,
        decision: "skip",
        reason: "disabled_component",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (artifact !== "project-host") {
      decisions.push({
        component,
        decision: "skip",
        reason: "unsupported_artifact",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (!currentArtifactVersion) {
      decisions.push({
        component,
        decision: "skip",
        reason: "missing_installed_artifact_version",
        artifact,
        desired_version: deployment.desired_version,
      });
      continue;
    }
    if (deployment.desired_version !== currentArtifactVersion) {
      decisions.push({
        component,
        decision: "skip",
        reason: "artifact_version_mismatch",
        artifact,
        desired_version: deployment.desired_version,
        current_artifact_version: currentArtifactVersion,
        observed_version_state: observedTarget?.observed_version_state,
        running_versions: observed.running_versions,
      });
      continue;
    }
    if (observedTarget?.observed_version_state === "aligned") {
      decisions.push({
        component,
        decision: "skip",
        reason: "already_aligned",
        artifact,
        desired_version: deployment.desired_version,
        current_artifact_version: currentArtifactVersion,
        observed_version_state: observedTarget.observed_version_state,
        running_versions: observed.running_versions,
      });
      continue;
    }
    decisions.push({
      component,
      decision: "rollout",
      reason: `${observedTarget?.observed_version_state ?? "drifted"}`,
      artifact,
      desired_version: deployment.desired_version,
      current_artifact_version: currentArtifactVersion,
      observed_version_state: observedTarget?.observed_version_state,
      running_versions: observed.running_versions,
    });
    reconciled_components.push(component);
  }

  return {
    ...(components?.length
      ? { requested_components: requestedComponents }
      : {}),
    reconciled_components,
    decisions,
  };
}

export function runtimeDeploymentsForUpgradeResults(
  results: HostSoftwareUpgradeResponse["results"],
  {
    alignRuntimeStack = false,
  }: {
    alignRuntimeStack?: boolean;
  } = {},
): HostRuntimeDeploymentUpsert[] {
  const deployments: HostRuntimeDeploymentUpsert[] = [];
  for (const result of results ?? []) {
    const target = normalizeRuntimeArtifactTarget(result.artifact);
    if (!target || !`${result.version ?? ""}`.trim()) continue;
    if (alignRuntimeStack && target === "project-host") {
      deployments.push(
        ...runtimeDeploymentsForAlignedProjectHostVersion({
          version: result.version,
        }),
      );
      continue;
    }
    deployments.push({
      target_type: "artifact",
      target,
      desired_version: result.version,
    });
  }
  return normalizeRuntimeDeploymentUpserts(deployments);
}

export function runtimeDeploymentsForComponentRollout({
  components,
  desired_version,
  reason,
}: {
  components: ManagedComponentKind[];
  desired_version?: string;
  reason?: string;
}): HostRuntimeDeploymentUpsert[] {
  const version = `${desired_version ?? ""}`.trim();
  if (!version) return [];
  return normalizeRuntimeDeploymentUpserts(
    (components ?? []).map((component) => ({
      target_type: "component",
      target: component,
      desired_version: version,
      rollout_policy: DEFAULT_RUNTIME_DEPLOYMENT_POLICY[component],
      rollout_reason: reason,
    })),
  );
}
