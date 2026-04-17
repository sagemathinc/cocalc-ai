/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Runtime deployment observation and rollback helpers for hosts.

What belongs here:

- pure helper logic that interprets host metadata and managed-component
  observations into deployment status / rollback summaries
- helper code that decides how to describe runtime drift, rollback targets,
  and local rollback markers

What does not belong here:

- database writes
- host control RPCs
- LRO creation / orchestration
- reconcile / rollout side effects

The goal is to keep the heavy orchestration code in `hosts.ts` while moving
the status/observation logic into a focused module that is easier to read.
*/

import type {
  HostRuntimeArtifact,
  HostRuntimeArtifactObservation,
  HostRuntimeDeploymentObservedTarget,
  HostRuntimeDeploymentObservedVersionState,
  HostRuntimeDeploymentRecord,
  HostRuntimeDeploymentRollbackResult,
  HostRuntimeHostAgentObservation,
  HostRuntimeRollbackTarget,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentStatus,
  ManagedComponentKind,
} from "@cocalc/conat/project-host/api";

function deploymentObservedVersionState({
  desired_version,
  running_versions,
}: {
  desired_version: string;
  running_versions: string[];
}): HostRuntimeDeploymentObservedVersionState {
  if (!desired_version || running_versions.length === 0) {
    return "unknown";
  }
  if (running_versions.length > 1) {
    return "mixed";
  }
  return running_versions[0] === desired_version ? "aligned" : "drifted";
}

function componentDeploymentObservedVersionState({
  deployment,
  observed_component,
  observed_artifact,
}: {
  deployment: HostRuntimeDeploymentRecord;
  observed_component: HostManagedComponentStatus;
  observed_artifact?: HostRuntimeArtifactObservation;
}): HostRuntimeDeploymentObservedVersionState {
  const desiredArtifactVersion = `${deployment.desired_version ?? ""}`.trim();
  if (
    !desiredArtifactVersion ||
    observed_component.running_versions.length === 0
  ) {
    return "unknown";
  }
  const currentArtifactVersion =
    `${observed_artifact?.current_version ?? ""}`.trim();
  const currentArtifactBuildId =
    `${observed_artifact?.current_build_id ?? ""}`.trim();
  if (
    currentArtifactVersion &&
    currentArtifactVersion === desiredArtifactVersion &&
    currentArtifactBuildId
  ) {
    return deploymentObservedVersionState({
      desired_version: currentArtifactBuildId,
      running_versions: observed_component.running_versions,
    });
  }
  return deploymentObservedVersionState({
    desired_version: desiredArtifactVersion,
    running_versions: observed_component.running_versions,
  });
}

function sortVersionsDescending(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );
}

export function observedRuntimeArtifactsFromMetadata(
  row: any,
): HostRuntimeArtifactObservation[] {
  const inventory = Array.isArray(row?.metadata?.software_inventory)
    ? row.metadata.software_inventory
    : [];
  const normalizedInventory = inventory
    .map((entry: any) => {
      const artifact = `${entry?.artifact ?? ""}`.trim() as HostRuntimeArtifact;
      if (
        artifact !== "project-host" &&
        artifact !== "project-bundle" &&
        artifact !== "tools"
      ) {
        return undefined;
      }
      return {
        artifact,
        current_version: `${entry?.current_version ?? ""}`.trim() || undefined,
        current_build_id:
          `${entry?.current_build_id ?? ""}`.trim() || undefined,
        installed_versions: sortVersionsDescending(
          Array.isArray(entry?.installed_versions)
            ? entry.installed_versions.map((value: any) =>
                `${value ?? ""}`.trim(),
              )
            : [],
        ),
        referenced_versions: Array.isArray(entry?.referenced_versions)
          ? entry.referenced_versions
              .map((reference: any) => {
                const version = `${reference?.version ?? ""}`.trim();
                const project_count = Math.max(
                  0,
                  Math.floor(Number(reference?.project_count ?? 0) || 0),
                );
                if (!version || project_count <= 0) return undefined;
                return {
                  version,
                  project_count,
                };
              })
              .filter(
                (
                  reference,
                ): reference is {
                  version: string;
                  project_count: number;
                } => reference != null,
              )
          : undefined,
      } satisfies HostRuntimeArtifactObservation;
    })
    .filter((entry): entry is HostRuntimeArtifactObservation => entry != null);
  const existing = new Map<HostRuntimeArtifact, HostRuntimeArtifactObservation>(
    normalizedInventory.map((entry) => [entry.artifact, entry]),
  );
  const software = row?.metadata?.software ?? {};
  const fallbacks: HostRuntimeArtifactObservation[] = [
    {
      artifact: "project-host",
      current_version: `${software?.project_host ?? ""}`.trim() || undefined,
      current_build_id:
        `${software?.project_host_build_id ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.project_host ?? ""}`.trim()
          ? [`${software.project_host}`.trim()]
          : [],
      ),
    },
    {
      artifact: "project-bundle",
      current_version: `${software?.project_bundle ?? ""}`.trim() || undefined,
      current_build_id:
        `${software?.project_bundle_build_id ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.project_bundle ?? ""}`.trim()
          ? [`${software.project_bundle}`.trim()]
          : [],
      ),
    },
    {
      artifact: "tools",
      current_version: `${software?.tools ?? ""}`.trim() || undefined,
      installed_versions: sortVersionsDescending(
        `${software?.tools ?? ""}`.trim() ? [`${software.tools}`.trim()] : [],
      ),
    },
  ];
  for (const fallback of fallbacks) {
    if (!existing.has(fallback.artifact)) {
      existing.set(fallback.artifact, fallback);
    }
  }
  return [...existing.values()].sort((a, b) =>
    a.artifact < b.artifact ? -1 : a.artifact > b.artifact ? 1 : 0,
  );
}

export function observedHostAgentFromMetadata(
  row: any,
): HostRuntimeHostAgentObservation | undefined {
  const projectHost = row?.metadata?.host_agent?.project_host;
  if (!projectHost || typeof projectHost !== "object") {
    return undefined;
  }
  const lastKnownGoodVersion =
    `${projectHost?.last_known_good_version ?? ""}`.trim() || undefined;
  const pendingTargetVersion =
    `${projectHost?.pending_rollout?.target_version ?? ""}`.trim() || undefined;
  const pendingPreviousVersion =
    `${projectHost?.pending_rollout?.previous_version ?? ""}`.trim() ||
    undefined;
  const pendingStartedAt =
    `${projectHost?.pending_rollout?.started_at ?? ""}`.trim() || undefined;
  const pendingDeadlineAt =
    `${projectHost?.pending_rollout?.deadline_at ?? ""}`.trim() || undefined;
  const rollbackTargetVersion =
    `${projectHost?.last_automatic_rollback?.target_version ?? ""}`.trim() ||
    undefined;
  const rollbackVersion =
    `${projectHost?.last_automatic_rollback?.rollback_version ?? ""}`.trim() ||
    undefined;
  const rollbackStartedAt =
    `${projectHost?.last_automatic_rollback?.started_at ?? ""}`.trim() ||
    undefined;
  const rollbackFinishedAt =
    `${projectHost?.last_automatic_rollback?.finished_at ?? ""}`.trim() ||
    undefined;
  const rollbackReason =
    `${projectHost?.last_automatic_rollback?.reason ?? ""}`.trim() || undefined;
  if (
    !lastKnownGoodVersion &&
    !pendingTargetVersion &&
    !rollbackTargetVersion &&
    !rollbackVersion
  ) {
    return undefined;
  }
  return {
    project_host: {
      last_known_good_version: lastKnownGoodVersion,
      pending_rollout:
        pendingTargetVersion && pendingPreviousVersion
          ? {
              target_version: pendingTargetVersion,
              previous_version: pendingPreviousVersion,
              started_at: pendingStartedAt ?? "",
              deadline_at: pendingDeadlineAt ?? "",
            }
          : undefined,
      last_automatic_rollback:
        rollbackTargetVersion && rollbackVersion
          ? {
              target_version: rollbackTargetVersion,
              rollback_version: rollbackVersion,
              started_at: rollbackStartedAt ?? "",
              finished_at: rollbackFinishedAt ?? "",
              reason:
                rollbackReason === "health_deadline_exceeded"
                  ? "health_deadline_exceeded"
                  : "health_deadline_exceeded",
            }
          : undefined,
    },
  };
}

export function isUnsupportedHostAgentStatusObservationError(
  error: any,
): boolean {
  const message = `${error?.message ?? error ?? ""}`.trim();
  if (!message) {
    return false;
  }
  return (
    /getHostAgentStatus/.test(message) &&
    /(unknown function|is not a function|not implemented)/i.test(message)
  );
}

function observedRuntimeArtifactVersionState({
  desired_version,
  current_version,
  installed_versions,
}: {
  desired_version: string;
  current_version?: string;
  installed_versions: string[];
}): HostRuntimeDeploymentObservedVersionState {
  if (!desired_version) {
    return "unknown";
  }
  if (current_version && current_version === desired_version) {
    return "aligned";
  }
  if (installed_versions.includes(desired_version)) {
    return "drifted";
  }
  if (current_version || installed_versions.length > 0) {
    return "missing";
  }
  return "unobserved";
}

function deploymentArtifactForRollback({
  deployment,
  observed_components,
}: {
  deployment: HostRuntimeDeploymentRecord;
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeArtifact {
  if (deployment.target_type === "artifact") {
    return deployment.target as HostRuntimeArtifact;
  }
  const component = (observed_components ?? []).find(
    (entry) => entry.component === deployment.target,
  );
  return (component?.artifact ?? "project-host") as HostRuntimeArtifact;
}

function lastKnownGoodArtifactVersion(
  row: any,
  artifact: HostRuntimeArtifact,
): string | undefined {
  const runtimeDeployments =
    row?.metadata?.runtime_deployments?.last_known_good_versions ?? {};
  const legacy = row?.metadata?.last_known_good_versions ?? {};
  return (
    `${runtimeDeployments?.[artifact] ?? legacy?.[artifact] ?? ""}`.trim() ||
    undefined
  );
}

export function summarizeRollbackTargets({
  row,
  effective,
  observed_artifacts,
  observed_components,
}: {
  row: any;
  effective: HostRuntimeDeploymentRecord[];
  observed_artifacts?: HostRuntimeArtifactObservation[];
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeRollbackTarget[] {
  const artifacts = new Map(
    (observed_artifacts ?? []).map((artifact) => [artifact.artifact, artifact]),
  );
  return effective.map((deployment) => {
    const artifact = deploymentArtifactForRollback({
      deployment,
      observed_components,
    });
    const observed = artifacts.get(artifact);
    const retained_versions = sortVersionsDescending(
      observed?.installed_versions ?? [],
    );
    const current_version = observed?.current_version;
    const previous_version = retained_versions.find(
      (version) => version !== current_version,
    );
    return {
      target_type: deployment.target_type,
      target: deployment.target,
      artifact,
      desired_version: deployment.desired_version,
      current_version,
      previous_version,
      last_known_good_version: lastKnownGoodArtifactVersion(row, artifact),
      retained_versions,
    };
  });
}

export function resolveRollbackVersion({
  rollbackTarget,
  version,
  last_known_good,
}: {
  rollbackTarget: HostRuntimeRollbackTarget;
  version?: string;
  last_known_good?: boolean;
}): {
  rollback_version: string;
  rollback_source: HostRuntimeDeploymentRollbackResult["rollback_source"];
} {
  const explicit = `${version ?? ""}`.trim();
  if (explicit) {
    return {
      rollback_version: explicit,
      rollback_source: "explicit_version",
    };
  }
  if (last_known_good) {
    const candidate = `${rollbackTarget.last_known_good_version ?? ""}`.trim();
    if (!candidate) {
      throw new Error("last known good version is not available");
    }
    return {
      rollback_version: candidate,
      rollback_source: "last_known_good",
    };
  }
  const previous = `${rollbackTarget.previous_version ?? ""}`.trim();
  if (!previous) {
    throw new Error("previous rollback version is not available");
  }
  return {
    rollback_version: previous,
    rollback_source: "previous_version",
  };
}

export function summarizeObservedRuntimeDeployments({
  effective,
  observed_artifacts,
  observed_components,
}: {
  effective: HostRuntimeDeploymentRecord[];
  observed_artifacts?: HostRuntimeArtifactObservation[];
  observed_components?: HostManagedComponentStatus[];
}): HostRuntimeDeploymentObservedTarget[] {
  const components = new Map(
    (observed_components ?? []).map((component) => [
      component.component,
      component,
    ]),
  );
  const artifacts = new Map(
    (observed_artifacts ?? []).map((artifact) => [artifact.artifact, artifact]),
  );
  return effective.map((deployment) => {
    if (deployment.target_type !== "component") {
      if (deployment.target === "bootstrap-environment") {
        return {
          target_type: deployment.target_type,
          target: deployment.target,
          desired_version: deployment.desired_version,
          rollout_policy: deployment.rollout_policy,
          observed_version_state: "unsupported",
        };
      }
      const observed = artifacts.get(deployment.target as HostRuntimeArtifact);
      if (!observed) {
        return {
          target_type: deployment.target_type,
          target: deployment.target,
          desired_version: deployment.desired_version,
          rollout_policy: deployment.rollout_policy,
          observed_version_state: "unobserved",
        };
      }
      return {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: deployment.desired_version,
        rollout_policy: deployment.rollout_policy,
        observed_version_state: observedRuntimeArtifactVersionState({
          desired_version: deployment.desired_version,
          current_version: observed.current_version,
          installed_versions: observed.installed_versions,
        }),
        current_version: observed.current_version,
        current_build_id: observed.current_build_id,
        installed_versions: observed.installed_versions,
      };
    }
    const observed = components.get(deployment.target as ManagedComponentKind);
    if (!observed) {
      return {
        target_type: deployment.target_type,
        target: deployment.target,
        desired_version: deployment.desired_version,
        rollout_policy: deployment.rollout_policy,
        observed_version_state: "unobserved",
      };
    }
    const observedArtifact = artifacts.get(
      (observed.artifact ?? "project-host") as HostRuntimeArtifact,
    );
    return {
      target_type: deployment.target_type,
      target: deployment.target,
      desired_version: deployment.desired_version,
      rollout_policy: deployment.rollout_policy,
      observed_runtime_state: observed.runtime_state,
      observed_version_state: componentDeploymentObservedVersionState({
        deployment,
        observed_component: observed,
        observed_artifact: observedArtifact,
      }),
      running_versions: observed.running_versions,
      running_pids: observed.running_pids,
      enabled: observed.enabled,
      managed: observed.managed,
    };
  });
}

export function installedProjectHostArtifactVersion(
  row: any,
): string | undefined {
  const version =
    `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
    undefined;
  return version;
}

const PROJECT_HOST_LOCAL_ROLLBACK_ERROR_CODE = "PROJECT_HOST_LOCAL_ROLLBACK";

export function isProjectHostLocalRollbackError(err: any): err is Error & {
  code: typeof PROJECT_HOST_LOCAL_ROLLBACK_ERROR_CODE;
  automaticRollback: {
    host_id: string;
    rollback_version: string;
    source: "host-agent";
  };
} {
  return (
    err instanceof Error &&
    `${(err as any)?.code ?? ""}` === PROJECT_HOST_LOCAL_ROLLBACK_ERROR_CODE &&
    `${(err as any)?.automaticRollback?.rollback_version ?? ""}`.trim().length >
      0
  );
}

export function targetKeyForRuntimeDeployment(opts: {
  target_type: HostRuntimeDeploymentRecord["target_type"];
  target: HostRuntimeDeploymentRecord["target"];
}): string {
  return `${opts.target_type}:${opts.target}`;
}
