/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  HostRuntimeDeploymentObservedTarget,
  HostRuntimeDeploymentStatus,
  HostRuntimeHostAgentProjectHostAutomaticRollback,
  HostRuntimeHostAgentProjectHostObservation,
} from "@cocalc/conat/hub/api/hosts";
import type { LroEvent, LroSummary } from "@cocalc/conat/hub/api/lro";

const PROJECT_HOST_ROLLOUT_OP_KINDS = new Set([
  "host-upgrade-software",
  "host-reconcile-software",
  "host-reconcile-runtime-deployments",
  "host-rollback-runtime-deployments",
  "host-rollout-managed-components",
]);

export type HostRolloutDisplayPhase = {
  label: string;
  owner:
    | "artifact installation"
    | "project-host activation"
    | "managed component alignment";
  deadlineAt?: string;
  targetVersion?: string;
  observedVersion?: string;
};

export type ProjectHostRolloutLroState = {
  op_id?: string;
  kind?: string;
  summary?: Partial<LroSummary>;
  last_progress?: Partial<Extract<LroEvent, { type: "progress" }>>;
};

function toTimestamp(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const ts =
    value instanceof Date ? value.getTime() : Date.parse(`${value ?? ""}`);
  return Number.isFinite(ts) ? ts : undefined;
}

export function currentProjectHostAutomaticRollback({
  observation,
  currentVersion,
}: {
  observation?: HostRuntimeHostAgentProjectHostObservation;
  currentVersion?: string;
}): HostRuntimeHostAgentProjectHostAutomaticRollback | undefined {
  const rollback = observation?.last_automatic_rollback;
  if (!rollback) {
    return undefined;
  }
  if (currentVersion && rollback.rollback_version !== currentVersion) {
    return undefined;
  }
  return rollback;
}

export function shouldSuppressProjectHostFailedOp({
  op,
  currentVersion,
  observation,
}: {
  op?: ProjectHostRolloutLroState;
  currentVersion?: string;
  observation?: HostRuntimeHostAgentProjectHostObservation;
}): boolean {
  const rollback = currentProjectHostAutomaticRollback({
    observation,
    currentVersion,
  });
  if (!op?.summary || !rollback) {
    return false;
  }
  if (op.summary.status !== "failed") {
    return false;
  }
  const kind = op.summary.kind ?? op.kind;
  if (!kind || !PROJECT_HOST_ROLLOUT_OP_KINDS.has(kind)) {
    return false;
  }
  const opTs =
    toTimestamp(op.summary.updated_at) ??
    toTimestamp(op.summary.finished_at) ??
    toTimestamp(op.summary.created_at);
  const rollbackTs = toTimestamp(rollback.finished_at);
  if (opTs == null || rollbackTs == null) {
    return false;
  }
  return rollbackTs >= opTs;
}

export function projectHostRollbackReasonLabel(
  reason?: HostRuntimeHostAgentProjectHostAutomaticRollback["reason"],
): string {
  switch (reason) {
    case "health_deadline_exceeded":
      return "health deadline exceeded";
    default:
      return "automatic rollback";
  }
}

function observedTargetForArtifact(
  status: HostRuntimeDeploymentStatus | undefined,
  artifact: "project-host",
): HostRuntimeDeploymentObservedTarget | undefined {
  return status?.observed_targets?.find(
    (record) => record.target_type === "artifact" && record.target === artifact,
  );
}

function observedTargetForComponent(
  status: HostRuntimeDeploymentStatus | undefined,
  component: "project-host" | "conat-router" | "conat-persist" | "acp-worker",
): HostRuntimeDeploymentObservedTarget | undefined {
  return status?.observed_targets?.find(
    (record) =>
      record.target_type === "component" && record.target === component,
  );
}

function messageContains(
  message: string | undefined,
  pattern: RegExp,
): boolean {
  return !!message && pattern.test(message);
}

function progressMessage(op?: ProjectHostRolloutLroState): string | undefined {
  const value =
    op?.last_progress?.message ??
    (typeof op?.summary?.progress_summary?.message === "string"
      ? op.summary.progress_summary.message
      : undefined);
  const text = `${value ?? ""}`.trim();
  return text || undefined;
}

function progressSummaryPhase(
  op?: ProjectHostRolloutLroState,
): HostRolloutDisplayPhase | undefined {
  const summary = op?.summary?.progress_summary ?? {};
  const label = `${summary?.rollout_phase_label ?? ""}`.trim();
  const owner = `${summary?.rollout_phase_owner ?? ""}`.trim();
  if (!label) {
    return undefined;
  }
  if (
    owner !== "artifact installation" &&
    owner !== "project-host activation" &&
    owner !== "managed component alignment"
  ) {
    return undefined;
  }
  return {
    label,
    owner,
    deadlineAt: `${summary?.rollout_deadline_at ?? ""}`.trim() || undefined,
    targetVersion:
      `${summary?.rollout_target_version ?? ""}`.trim() || undefined,
    observedVersion:
      `${summary?.rollout_observed_version ?? ""}`.trim() || undefined,
  };
}

function currentManagedAlignmentPhase(
  status?: HostRuntimeDeploymentStatus,
): HostRolloutDisplayPhase | undefined {
  const router = observedTargetForComponent(status, "conat-router");
  if (
    router &&
    (router.observed_version_state !== "aligned" ||
      router.observed_runtime_state !== "running")
  ) {
    return {
      label: "Restarting conat router",
      owner: "managed component alignment",
    };
  }

  const persist = observedTargetForComponent(status, "conat-persist");
  if (
    persist &&
    (persist.observed_version_state !== "aligned" ||
      persist.observed_runtime_state !== "running")
  ) {
    return {
      label: "Restarting conat persist",
      owner: "managed component alignment",
    };
  }

  const acp = observedTargetForComponent(status, "acp-worker");
  if (
    acp &&
    (acp.observed_version_state !== "aligned" ||
      acp.observed_runtime_state !== "running")
  ) {
    return {
      label: "Draining/replacing ACP worker",
      owner: "managed component alignment",
    };
  }

  return undefined;
}

export function currentProjectHostRolloutPhase({
  op,
  currentVersion,
  observation,
  deploymentStatus,
}: {
  op?: ProjectHostRolloutLroState;
  currentVersion?: string;
  observation?: HostRuntimeHostAgentProjectHostObservation;
  deploymentStatus?: HostRuntimeDeploymentStatus;
}): HostRolloutDisplayPhase | undefined {
  if (!op) return undefined;
  if (`${op.summary?.status ?? ""}`.trim() !== "running") {
    return undefined;
  }
  const kind = op.summary?.kind ?? op.kind;
  if (!kind || !PROJECT_HOST_ROLLOUT_OP_KINDS.has(kind)) {
    return undefined;
  }
  const summaryPhase = progressSummaryPhase(op);
  if (summaryPhase) {
    return summaryPhase;
  }

  const message = progressMessage(op);
  const pending = observation?.pending_rollout;
  const projectHostArtifact = observedTargetForArtifact(
    deploymentStatus,
    "project-host",
  );
  const projectHostComponent = observedTargetForComponent(
    deploymentStatus,
    "project-host",
  );
  const desiredVersion =
    `${projectHostComponent?.desired_version ?? projectHostArtifact?.desired_version ?? pending?.target_version ?? ""}`.trim() ||
    undefined;
  const artifactState = projectHostArtifact?.observed_version_state;
  const projectHostRunning = projectHostComponent?.running_versions ?? [];

  if (
    artifactState === "missing" ||
    messageContains(message, /running upgrade|downloading|resolving artifact/i)
  ) {
    return {
      label: "Downloading/installing artifact",
      owner: "artifact installation",
    };
  }

  if (artifactState === "drifted") {
    return {
      label: "Installing artifact",
      owner: "artifact installation",
    };
  }

  if (pending) {
    if (projectHostRunning.includes(pending.target_version)) {
      return {
        label: "Candidate running; evaluating health",
        owner: "project-host activation",
        deadlineAt: pending.deadline_at,
      };
    }
    return {
      label: "Waiting for host-agent to restart project-host",
      owner: "project-host activation",
      deadlineAt: pending.deadline_at,
    };
  }

  if (
    desiredVersion &&
    projectHostArtifact?.current_version === desiredVersion &&
    !projectHostRunning.includes(desiredVersion)
  ) {
    return {
      label: "Installed on host; waiting for project-host restart",
      owner: "project-host activation",
    };
  }

  if (
    desiredVersion &&
    projectHostRunning.includes(desiredVersion) &&
    observation?.last_known_good_version &&
    observation.last_known_good_version !== desiredVersion
  ) {
    return {
      label: "Candidate running; awaiting promotion",
      owner: "project-host activation",
    };
  }

  if (
    desiredVersion &&
    projectHostRunning.includes(desiredVersion) &&
    observation?.last_known_good_version === desiredVersion
  ) {
    return currentManagedAlignmentPhase(deploymentStatus);
  }

  if (messageContains(message, /rolling out upgraded managed components/i)) {
    return {
      label: "Rolling out managed components",
      owner: "managed component alignment",
    };
  }

  if (
    messageContains(
      message,
      /running reconcile|reconciling runtime deployments/i,
    )
  ) {
    return {
      label: "Reconciling runtime deployments",
      owner: "managed component alignment",
    };
  }

  if (
    messageContains(
      message,
      /waiting for host to return|waiting for host heartbeat/i,
    )
  ) {
    return {
      label: "Waiting for host heartbeat",
      owner: "managed component alignment",
    };
  }

  if (
    desiredVersion &&
    currentVersion &&
    desiredVersion !== currentVersion &&
    !deploymentStatus
  ) {
    return {
      label: "Rolling out project-host",
      owner: "project-host activation",
    };
  }

  return undefined;
}
