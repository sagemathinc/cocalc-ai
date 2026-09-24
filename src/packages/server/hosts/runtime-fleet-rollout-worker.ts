/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { randomUUID } from "node:crypto";
import { conat } from "@cocalc/backend/conat";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { promoteProjectHostRuntimeDeployments } from "@cocalc/database/postgres/project-host-runtime-deployments";
import { getProjectHostStoragePressureWindows } from "@cocalc/database/postgres/project-host-metrics";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import type { LaunchHealthLevel } from "@cocalc/conat/hub/api/system";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";
import {
  getHostRuntimeDeploymentStatus,
  rolloutHostManagedComponents,
  upgradeHostSoftware,
} from "@cocalc/server/conat/api/hosts";
import { computeHostOperationalAvailability } from "@cocalc/server/conat/api/hosts-normalization";
import {
  hostOverridesEveryRolloutTarget,
  loadHostRuntimeDeploymentTargetKeys,
  runtimeFleetDeploymentTargetKeys,
} from "./runtime-fleet-overrides";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getLaunchHealth } from "@cocalc/server/conat/api/system";
import {
  getProjectRecoveryAttemptHealth,
  getProjectRecoveryHealth,
} from "@cocalc/server/projects/maintenance-status";
import {
  claimLroOps,
  getLro,
  touchLro,
  updateLro,
} from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { waitForDurableLroCompletion } from "@cocalc/server/lro/wait";

const logger = getLogger("server:hosts:runtime-fleet-rollout-worker");
const KIND = "host-runtime-fleet-rollout";
const OWNER_TYPE = "hub" as const;
const OWNER_ID = randomUUID();
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 15_000;
const TICK_MS = 5_000;
const CHILD_TIMEOUT_MS = 20 * 60_000;
const STABILITY_POLL_MS = 5_000;

type RolloutHostResult = {
  host_id: string;
  status: "succeeded" | "failed";
  child_op_id?: string;
  managed_component_op_id?: string;
  started_at: string;
  finished_at: string;
  stabilization_seconds: number;
  error?: string;
};

type RolloutWave = {
  ids: string[];
  stabilize_seconds: number;
};

type RecoveryStopGateHost = {
  failed_attempts: number;
  oldest_backup_delay_seconds: number;
  emergency_seconds: number | null;
  latest_valid_pressure_at: string | null;
};

type RecoveryStopGateSnapshot = {
  checked_at: string;
  recovery_level: LaunchHealthLevel;
  latency_level: LaunchHealthLevel;
  hosts: Record<string, RecoveryStopGateHost>;
};

const PRESSURE_FRESHNESS_MS = 5 * 60_000;
const BACKUP_AGE_REGRESSION_GRACE_SECONDS = 5 * 60;

async function captureRecoveryStopGate({
  account_id,
  host_ids,
}: {
  account_id: string;
  host_ids: string[];
}): Promise<RecoveryStopGateSnapshot> {
  const [health, recovery, attempts, pressure] = await Promise.all([
    getLaunchHealth({ account_id }),
    getProjectRecoveryHealth(),
    getProjectRecoveryAttemptHealth(),
    getProjectHostStoragePressureWindows({ bay_id: getConfiguredBayId() }),
  ]);
  const level = (id: string): LaunchHealthLevel =>
    health.checks.find((check) => check.id === id)?.level ?? "unknown";
  const hosts: Record<string, RecoveryStopGateHost> = {};
  for (const host_id of host_ids) {
    const hostPressure = pressure.find((row) => row.host_id === host_id);
    hosts[host_id] = {
      failed_attempts: attempts.by_host
        .filter((row) => row.host_id === host_id)
        .reduce((total, row) => total + row.failed, 0),
      oldest_backup_delay_seconds: Math.max(
        0,
        ...recovery.by_host_class
          .filter((row) => row.host_id === host_id && row.kind === "backup")
          .map((row) => row.oldest_delay_seconds),
      ),
      emergency_seconds: hostPressure?.emergency_seconds ?? null,
      latest_valid_pressure_at: hostPressure?.latest_valid_sample_at ?? null,
    };
  }
  return {
    checked_at: health.checked_at,
    recovery_level: level("project-recovery"),
    latency_level: level("ux-latency"),
    hosts,
  };
}

async function countFailedRecoveryAttemptsSince({
  since,
  host_ids,
}: {
  since: string;
  host_ids: string[];
}): Promise<number> {
  if (!host_ids.length) return 0;
  const { rows } = await getPool().query<{ failed: number }>(
    `SELECT COUNT(*)::int AS failed
       FROM project_maintenance_attempts
      WHERE observed_at > ($1::timestamptz AT TIME ZONE 'UTC')
        AND host_id = ANY($2::uuid[])
        AND outcome = 'failed'`,
    [since, host_ids],
  );
  return rows[0]?.failed ?? 0;
}

function recoveryStopGateFailure({
  baseline,
  current,
  host_ids,
  require_measured_latency = false,
}: {
  baseline: RecoveryStopGateSnapshot;
  current: RecoveryStopGateSnapshot;
  host_ids: string[];
  require_measured_latency?: boolean;
}): string | undefined {
  if (baseline.recovery_level === "unknown") {
    return "project recovery baseline is unknown";
  }
  if (current.recovery_level === "unknown") {
    return "project recovery health is unknown";
  }
  if (require_measured_latency && current.latency_level === "unknown") {
    return "interactive latency is unmeasured; global promotion requires browser latency samples";
  }
  const rank = (level: LaunchHealthLevel) =>
    level === "critical" ? 2 : level === "warning" ? 1 : 0;
  if (rank(current.recovery_level) > rank(baseline.recovery_level)) {
    return `project recovery health worsened from ${baseline.recovery_level} to ${current.recovery_level}`;
  }
  if (
    baseline.latency_level !== "unknown" &&
    current.latency_level === "unknown"
  ) {
    return "interactive latency health became unknown";
  }
  if (rank(current.latency_level) > rank(baseline.latency_level)) {
    return `interactive latency health worsened from ${baseline.latency_level} to ${current.latency_level}`;
  }
  const elapsedSeconds = Math.max(
    0,
    (Date.parse(current.checked_at) - Date.parse(baseline.checked_at)) / 1000,
  );
  for (const host_id of host_ids) {
    const before = baseline.hosts[host_id];
    const after = current.hosts[host_id];
    if (!before || !after) {
      return `missing recovery stop-gate data for host ${host_id}`;
    }
    if (after.failed_attempts > before.failed_attempts) {
      return `host ${host_id} recorded new failed recovery attempts`;
    }
    if (
      after.oldest_backup_delay_seconds >
      before.oldest_backup_delay_seconds +
        elapsedSeconds +
        BACKUP_AGE_REGRESSION_GRACE_SECONDS
    ) {
      return `host ${host_id} backup debt age regressed beyond elapsed time`;
    }
    if (
      after.emergency_seconds != null &&
      after.emergency_seconds > (before.emergency_seconds ?? 0)
    ) {
      return `host ${host_id} entered emergency storage pressure`;
    }
    if (
      before.latest_valid_pressure_at != null &&
      (after.latest_valid_pressure_at == null ||
        Date.parse(current.checked_at) -
          Date.parse(after.latest_valid_pressure_at) >
          PRESSURE_FRESHNESS_MS)
    ) {
      return `host ${host_id} lost fresh storage pressure telemetry`;
    }
  }
  return undefined;
}

function savedRecoveryStopGateBaseline(
  value: unknown,
  host_ids: string[],
): RecoveryStopGateSnapshot | undefined {
  if (!value || typeof value !== "object") return;
  const snapshot = value as RecoveryStopGateSnapshot;
  if (
    !Number.isFinite(Date.parse(snapshot.checked_at)) ||
    !["healthy", "warning", "critical", "unknown"].includes(
      snapshot.recovery_level,
    ) ||
    !["healthy", "warning", "critical", "unknown"].includes(
      snapshot.latency_level,
    ) ||
    !snapshot.hosts ||
    host_ids.some((id) => !snapshot.hosts[id])
  ) {
    return;
  }
  return snapshot;
}

async function assertRecoveryStopGate({
  baseline,
  current,
  host_ids,
  require_measured_latency,
}: {
  baseline: RecoveryStopGateSnapshot;
  current: RecoveryStopGateSnapshot;
  host_ids: string[];
  require_measured_latency?: boolean;
}): Promise<void> {
  const failure = recoveryStopGateFailure({
    baseline,
    current,
    host_ids,
    require_measured_latency,
  });
  if (failure) throw new Error(`fleet rollout health gate stopped: ${failure}`);
  const newFailures = await countFailedRecoveryAttemptsSince({
    since: baseline.checked_at,
    host_ids,
  });
  if (newFailures) {
    throw new Error(
      `fleet rollout health gate stopped: ${newFailures} new failed recovery attempt(s) on the upgraded hosts`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedRolloutComponents(value: unknown): ManagedComponentKind[] {
  const componentOrder: ManagedComponentKind[] = [
    "project-host",
    "conat-router",
    "conat-persist",
    "acp-worker",
  ];
  const allowed = new Set<ManagedComponentKind>(componentOrder);
  const requested = Array.isArray(value) ? value : ["project-host"];
  const normalized = Array.from(
    new Set(
      requested.map((component) => `${component ?? ""}`.trim()).filter(Boolean),
    ),
  );
  if (!normalized.length) {
    throw new Error("fleet rollout requires at least one managed component");
  }
  const invalid = normalized.filter(
    (component) => !allowed.has(component as ManagedComponentKind),
  );
  if (invalid.length) {
    throw new Error(`unsupported managed component(s): ${invalid.join(", ")}`);
  }
  const selected = new Set(normalized as ManagedComponentKind[]);
  return componentOrder.filter((component) => selected.has(component));
}

function runtimeDeploymentsForPromotion({
  version,
  components,
  reason,
  metadata,
}: {
  version: string;
  components: ManagedComponentKind[];
  reason?: string;
  metadata: Record<string, any>;
}) {
  const promotesProjectHost = components.includes("project-host");
  return [
    ...(promotesProjectHost
      ? [
          {
            target_type: "artifact" as const,
            target: "project-host" as const,
            desired_version: version,
            rollout_reason: reason,
            metadata,
          },
        ]
      : []),
    ...components.map((component) => ({
      target_type: "component" as const,
      target: component,
      desired_version: version,
      rollout_policy:
        component === "acp-worker"
          ? ("drain_then_replace" as const)
          : ("restart_now" as const),
      rollout_reason: reason,
      metadata,
    })),
  ];
}

function runtimeObservationIsStable({
  status,
  version,
  components,
}: {
  status: Awaited<ReturnType<typeof getHostRuntimeDeploymentStatus>>;
  version: string;
  components: ManagedComponentKind[];
}): boolean {
  if (`${status.observation_error ?? ""}`.trim()) return false;
  const artifact = (status.observed_artifacts ?? []).find(
    (entry) => entry.artifact === "project-host",
  );
  const observedComponents = new Map(
    (status.observed_components ?? []).map((entry) => [entry.component, entry]),
  );
  const expectedAuxiliaryVersion =
    artifact?.current_version === version
      ? (artifact.current_build_id ?? version)
      : version;
  const requiredComponents = new Set<ManagedComponentKind>(components);
  const componentsStable = Array.from(requiredComponents).every((component) => {
    const observed = observedComponents.get(component);
    if (observed?.runtime_state !== "running") return false;
    if (component === "acp-worker") {
      const desiredVersion = `${observed.desired_version ?? ""}`.trim();
      const runningVersions = new Set(observed.running_versions ?? []);
      return (
        observed.version_state === "aligned" ||
        (observed.upgrade_policy === "drain_then_replace" &&
          !!desiredVersion &&
          runningVersions.has(desiredVersion))
      );
    }
    if (component === "project-host") {
      return observed.version_state === "aligned";
    }
    const runningVersions = [...new Set(observed.running_versions ?? [])];
    return (
      runningVersions.length === 1 &&
      runningVersions[0] === expectedAuxiliaryVersion
    );
  });
  if (!components.includes("project-host")) {
    return componentsStable;
  }
  const rollout = status.observed_host_agent?.project_host?.rollout;
  return (
    artifact?.current_version === version &&
    componentsStable &&
    rollout?.target_version === version &&
    rollout?.running_version === version &&
    rollout?.healthy === true &&
    rollout?.phase === "promoted"
  );
}

function componentRuntimeVersionsForPromotion({
  statuses,
  components,
}: {
  statuses: Array<Awaited<ReturnType<typeof getHostRuntimeDeploymentStatus>>>;
  components: ManagedComponentKind[];
}): Partial<Record<ManagedComponentKind, string>> {
  const versions: Partial<Record<ManagedComponentKind, string>> = {};
  for (const component of components) {
    const observedVersions = new Set<string>();
    for (const status of statuses) {
      const observed = (status.observed_components ?? []).find(
        (entry) => entry.component === component,
      );
      let runningVersions = [
        ...new Set(
          (observed?.running_versions ?? [])
            .map((version) => `${version ?? ""}`.trim())
            .filter(Boolean),
        ),
      ];
      const desiredVersion = `${observed?.desired_version ?? ""}`.trim();
      if (
        component === "acp-worker" &&
        observed?.upgrade_policy === "drain_then_replace" &&
        desiredVersion &&
        runningVersions.includes(desiredVersion)
      ) {
        runningVersions = [desiredVersion];
      }
      if (runningVersions.length !== 1) {
        throw new Error(
          `cannot promote ${component}; host ${status.host_id} reports ${runningVersions.length || "no"} runtime versions`,
        );
      }
      observedVersions.add(runningVersions[0]);
    }
    if (observedVersions.size !== 1) {
      throw new Error(
        `cannot promote ${component}; hosts disagree on runtime version: ${[...observedVersions].join(", ")}`,
      );
    }
    versions[component] = [...observedVersions][0];
  }
  return versions;
}

async function observePromotionComponentRuntimeVersions({
  account_id,
  host_ids,
  version,
  components,
}: {
  account_id: string;
  host_ids: string[];
  version: string;
  components: ManagedComponentKind[];
}): Promise<Partial<Record<ManagedComponentKind, string>>> {
  const statuses: Array<
    Awaited<ReturnType<typeof getHostRuntimeDeploymentStatus>>
  > = [];
  for (let i = 0; i < host_ids.length; i += 5) {
    statuses.push(
      ...(await Promise.all(
        host_ids
          .slice(i, i + 5)
          .map((host_id) =>
            getHostRuntimeDeploymentStatus({ account_id, id: host_id }),
          ),
      )),
    );
  }
  for (const status of statuses) {
    if (!runtimeObservationIsStable({ status, version, components })) {
      throw new Error(
        `cannot promote runtime defaults; host ${status.host_id} is no longer stable on ${version}`,
      );
    }
  }
  return componentRuntimeVersionsForPromotion({ statuses, components });
}

async function waitForStableRuntime({
  account_id,
  host_id,
  version,
  components,
  stabilize_seconds,
  shouldCancel,
}: {
  account_id: string;
  host_id: string;
  version: string;
  components: ManagedComponentKind[];
  stabilize_seconds: number;
  shouldCancel: () => Promise<boolean>;
}): Promise<void> {
  const requiredStableMs = stabilize_seconds * 1000;
  const deadline =
    Date.now() + Math.max(3 * 60_000, requiredStableMs + 2 * 60_000);
  let stableSince: number | undefined;
  let lastError = "project-host has not reported the target version";
  while (Date.now() <= deadline) {
    if (await shouldCancel()) {
      throw new Error("fleet rollout canceled");
    }
    try {
      const status = await getHostRuntimeDeploymentStatus({
        account_id,
        id: host_id,
      });
      if (runtimeObservationIsStable({ status, version, components })) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= requiredStableMs) return;
      } else {
        stableSince = undefined;
        lastError =
          status.observation_error ||
          `runtime components have not converged to ${version}`;
      }
    } catch (err) {
      stableSince = undefined;
      lastError = `${err}`;
    }
    await delay(STABILITY_POLL_MS);
  }
  throw new Error(
    `host ${host_id} did not remain healthy for ${stabilize_seconds}s: ${lastError}`,
  );
}

async function runHostRollout({
  account_id,
  host_id,
  version,
  components,
  base_url,
  reason,
  stabilize_seconds,
  shouldCancel,
}: {
  account_id: string;
  host_id: string;
  version: string;
  components: ManagedComponentKind[];
  base_url?: string;
  reason?: string;
  stabilize_seconds: number;
  shouldCancel: () => Promise<boolean>;
}): Promise<RolloutHostResult> {
  const startedAt = new Date();
  let childOpId: string | undefined;
  let managedComponentOpId: string | undefined;
  try {
    if (components.includes("project-host")) {
      const child = await upgradeHostSoftware({
        account_id,
        id: host_id,
        targets: [{ artifact: "project-host", version }],
        base_url,
        align_runtime_stack: false,
        record_runtime_deployments: true,
      });
      childOpId = child.op_id;
      const summary = await waitForDurableLroCompletion({
        op_id: child.op_id,
        scope_type: child.scope_type,
        scope_id: child.scope_id,
        client: conat(),
        timeout_ms: CHILD_TIMEOUT_MS,
      });
      if (summary.status !== "succeeded") {
        throw new Error(
          summary.error ?? `project-host child rollout ${summary.status}`,
        );
      }
    }
    const auxiliaryComponents = components.filter(
      (component) => component !== "project-host",
    );
    if (auxiliaryComponents.length) {
      const componentChild = await rolloutHostManagedComponents({
        account_id,
        id: host_id,
        components: auxiliaryComponents,
        desired_version: version,
        base_url,
        reason,
      });
      managedComponentOpId = componentChild.op_id;
      const componentSummary = await waitForDurableLroCompletion({
        op_id: componentChild.op_id,
        scope_type: componentChild.scope_type,
        scope_id: componentChild.scope_id,
        client: conat(),
        timeout_ms: CHILD_TIMEOUT_MS,
      });
      if (componentSummary.status !== "succeeded") {
        throw new Error(
          componentSummary.error ??
            `managed component child rollout ${componentSummary.status}`,
        );
      }
    }
    await waitForStableRuntime({
      account_id,
      host_id,
      version,
      components,
      stabilize_seconds,
      shouldCancel,
    });
    return {
      host_id,
      status: "succeeded",
      child_op_id: childOpId,
      ...(managedComponentOpId
        ? { managed_component_op_id: managedComponentOpId }
        : {}),
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      stabilization_seconds: stabilize_seconds,
    };
  } catch (err) {
    return {
      host_id,
      status: "failed",
      ...(childOpId ? { child_op_id: childOpId } : {}),
      ...(managedComponentOpId
        ? { managed_component_op_id: managedComponentOpId }
        : {}),
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      stabilization_seconds: stabilize_seconds,
      error: `${err instanceof Error ? err.message : err}`,
    };
  }
}

function completedResults(op: LroSummary): RolloutHostResult[] {
  const results = op.progress_summary?.hosts;
  if (!Array.isArray(results)) return [];
  return results.filter(
    (result): result is RolloutHostResult =>
      !!result &&
      typeof result.host_id === "string" &&
      (result.status === "succeeded" || result.status === "failed"),
  );
}

function buildRolloutWaves({
  host_ids,
  completed_host_ids,
  canary_host_id,
  max_concurrent,
  canary_stabilize_seconds,
  stabilize_seconds,
}: {
  host_ids: string[];
  completed_host_ids: Set<string>;
  canary_host_id: string;
  max_concurrent: number;
  canary_stabilize_seconds: number;
  stabilize_seconds: number;
}): RolloutWave[] {
  const pending = host_ids.filter((hostId) => !completed_host_ids.has(hostId));
  const waves: RolloutWave[] = [];
  if (pending.includes(canary_host_id)) {
    waves.push({
      ids: [canary_host_id],
      stabilize_seconds: canary_stabilize_seconds,
    });
  }
  const remaining = pending.filter((hostId) => hostId !== canary_host_id);
  for (let i = 0; i < remaining.length; i += max_concurrent) {
    waves.push({
      ids: remaining.slice(i, i + max_concurrent),
      stabilize_seconds,
    });
  }
  return waves;
}

async function assertPromotionCohortStillComplete(
  hostIds: string[],
  components: ManagedComponentKind[],
): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT * FROM project_hosts WHERE deleted IS NULL`,
  );
  const localBayId = getConfiguredBayId();
  const cohort = new Set(hostIds);
  const localRows = rows.filter((row) => {
    const bayId = `${row.bay_id ?? ""}`.trim();
    return !bayId || bayId === localBayId;
  });
  const overrideKeysByHost = await loadHostRuntimeDeploymentTargetKeys(
    localRows.map((row) => `${row.id}`),
  );
  const rolloutTargetKeys = runtimeFleetDeploymentTargetKeys(components);
  const omittedHealthyHosts = rows
    .filter((row) => {
      const bayId = `${row.bay_id ?? ""}`.trim();
      const hostId = `${row.id}`;
      return (
        (!bayId || bayId === localBayId) &&
        !cohort.has(hostId) &&
        computeHostOperationalAvailability(row).operational &&
        !hostOverridesEveryRolloutTarget({
          hostId,
          overrideKeysByHost,
          rolloutTargetKeys,
        })
      );
    })
    .map((row) => `${row.name ?? row.id}`);
  if (omittedHealthyHosts.length) {
    throw new Error(
      `global promotion stopped because healthy local hosts joined outside the rollout cohort: ${omittedHealthyHosts.join(", ")}`,
    );
  }
}

async function handleRollout(op: LroSummary): Promise<void> {
  const input = op.input ?? {};
  const account_id = `${op.created_by ?? input.account_id ?? ""}`.trim();
  const hostIds: string[] = Array.from(
    new Set<string>(
      (Array.isArray(input.host_ids) ? input.host_ids : [])
        .map((id: unknown) => `${id ?? ""}`.trim())
        .filter(Boolean),
    ),
  );
  const version = `${input.version ?? ""}`.trim();
  const components = normalizedRolloutComponents(input.components);
  const maxConcurrent = Math.max(
    1,
    Math.min(5, Math.floor(Number(input.max_concurrent) || 1)),
  );
  const canaryHostId = `${input.canary_host_id ?? hostIds[0] ?? ""}`.trim();
  const canaryStabilizeSeconds = Math.max(
    0,
    Math.floor(Number(input.canary_stabilize_seconds) || 0),
  );
  const stabilizeSeconds = Math.max(
    0,
    Math.floor(Number(input.stabilize_seconds) || 0),
  );
  if (!account_id || !hostIds.length || !version || !canaryHostId) {
    throw new Error("fleet rollout is missing account, hosts, or version");
  }

  const heartbeat = setInterval(() => {
    void touchLro({
      op_id: op.op_id,
      owner_type: OWNER_TYPE,
      owner_id: OWNER_ID,
    }).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const shouldCancel = async () =>
    (await getLro(op.op_id))?.status === "canceled";
  let results = completedResults(op).filter(
    (result) => result.status === "succeeded",
  );
  const resultByHost = new Map(
    results.map((result) => [result.host_id, result]),
  );
  const priorBaseline = savedRecoveryStopGateBaseline(
    op.progress_summary?.recovery_stop_gate_baseline,
    hostIds,
  );
  const gatedHostIds = new Set<string>(
    Array.isArray(op.progress_summary?.recovery_stop_gate_passed_host_ids)
      ? op.progress_summary.recovery_stop_gate_passed_host_ids.filter(
          (id): id is string => typeof id === "string" && resultByHost.has(id),
        )
      : [],
  );
  let recoveryStopGateBaseline = priorBaseline;
  let recoveryStopGateLatest: RecoveryStopGateSnapshot | undefined;

  const publishProgress = async ({
    phase,
    message,
    wave,
  }: {
    phase: string;
    message: string;
    wave?: string[];
  }) => {
    const progress = Math.floor((resultByHost.size / hostIds.length) * 100);
    const progress_summary = {
      phase,
      message,
      version,
      components,
      completed: resultByHost.size,
      total: hostIds.length,
      progress,
      hosts: Array.from(resultByHost.values()),
      recovery_stop_gate_baseline: recoveryStopGateBaseline,
      recovery_stop_gate_latest: recoveryStopGateLatest,
      recovery_stop_gate_passed_host_ids: Array.from(gatedHostIds),
      ...(wave ? { wave } : {}),
    };
    const updated = await updateLro({
      op_id: op.op_id,
      status: "running",
      progress_summary,
      error: null,
    });
    if (updated)
      await publishLroSummary({
        scope_type: updated.scope_type,
        scope_id: updated.scope_id,
        summary: updated,
      });
    await publishLroEvent({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      op_id: op.op_id,
      event: {
        type: "progress",
        ts: Date.now(),
        phase,
        message,
        progress,
        detail: progress_summary,
      },
    }).catch(() => undefined);
  };

  try {
    if (!recoveryStopGateBaseline) {
      if (resultByHost.size) {
        throw new Error(
          "fleet rollout cannot resume upgraded hosts without a saved recovery baseline",
        );
      }
      recoveryStopGateBaseline = await captureRecoveryStopGate({
        account_id,
        host_ids: hostIds,
      });
    }
    if (recoveryStopGateBaseline.recovery_level === "unknown") {
      throw new Error("fleet rollout requires known project recovery health");
    }
    await publishProgress({
      phase: "starting",
      message: `starting paced rollout of ${components.join(", ")} from ${version}`,
    });
    const unGatedCompleted = Array.from(resultByHost.keys()).filter(
      (host_id) => !gatedHostIds.has(host_id),
    );
    if (unGatedCompleted.length) {
      recoveryStopGateLatest = await captureRecoveryStopGate({
        account_id,
        host_ids: hostIds,
      });
      await assertRecoveryStopGate({
        baseline: recoveryStopGateBaseline,
        current: recoveryStopGateLatest,
        host_ids: unGatedCompleted,
      });
      unGatedCompleted.forEach((host_id) => gatedHostIds.add(host_id));
      await publishProgress({
        phase: "health_gate_passed",
        message: `rechecked recovery health after worker restart for ${unGatedCompleted.join(", ")}`,
      });
    }
    const waves = buildRolloutWaves({
      host_ids: hostIds,
      completed_host_ids: new Set(resultByHost.keys()),
      canary_host_id: canaryHostId,
      max_concurrent: maxConcurrent,
      canary_stabilize_seconds: canaryStabilizeSeconds,
      stabilize_seconds: stabilizeSeconds,
    });

    for (const wave of waves) {
      if (await shouldCancel()) throw new Error("fleet rollout canceled");
      await publishProgress({
        phase:
          wave.ids.length === 1 && wave.ids[0] === canaryHostId
            ? "canary"
            : "wave",
        message: `rolling out ${wave.ids.join(", ")}`,
        wave: wave.ids,
      });
      const settled = await Promise.all(
        wave.ids.map((host_id) =>
          runHostRollout({
            account_id,
            host_id,
            version,
            components,
            base_url: `${input.base_url ?? ""}`.trim() || undefined,
            reason: `${input.reason ?? ""}`.trim() || undefined,
            stabilize_seconds: wave.stabilize_seconds,
            shouldCancel,
          }),
        ),
      );
      for (const result of settled) resultByHost.set(result.host_id, result);
      results = Array.from(resultByHost.values());
      const failure = settled.find((result) => result.status === "failed");
      if (failure) {
        throw new Error(
          `fleet rollout paused after ${failure.host_id} failed: ${failure.error}`,
        );
      }
      await publishProgress({
        phase: "health_gate_pending",
        message: `checking recovery health after ${wave.ids.join(", ")}`,
        wave: wave.ids,
      });
      recoveryStopGateLatest = await captureRecoveryStopGate({
        account_id,
        host_ids: hostIds,
      });
      await assertRecoveryStopGate({
        baseline: recoveryStopGateBaseline,
        current: recoveryStopGateLatest,
        host_ids: Array.from(new Set([...gatedHostIds, ...wave.ids])),
      });
      wave.ids.forEach((host_id) => gatedHostIds.add(host_id));
      await publishProgress({
        phase: "wave_complete",
        message: `completed wave ${wave.ids.join(", ")}; recovery health gate passed`,
        wave: wave.ids,
      });
    }

    if (input.promote_global === true) {
      recoveryStopGateLatest = await captureRecoveryStopGate({
        account_id,
        host_ids: hostIds,
      });
      await assertRecoveryStopGate({
        baseline: recoveryStopGateBaseline,
        current: recoveryStopGateLatest,
        host_ids: hostIds,
        require_measured_latency: true,
      });
      await publishProgress({
        phase: "promoting",
        message: "promoting successful rollout as the bay default",
      });
      await assertPromotionCohortStillComplete(hostIds, components);
      const component_runtime_versions =
        await observePromotionComponentRuntimeVersions({
          account_id,
          host_ids: hostIds,
          version,
          components,
        });
      const metadata = {
        fleet_rollout_op_id: op.op_id,
        components,
        component_runtime_versions,
        completed_at: new Date().toISOString(),
      };
      await promoteProjectHostRuntimeDeployments({
        host_ids: hostIds,
        requested_by: account_id,
        deployments: runtimeDeploymentsForPromotion({
          version,
          components,
          reason: input.reason,
          metadata,
        }),
      });
    }

    const result = {
      version,
      components,
      host_count: hostIds.length,
      promote_global: input.promote_global === true,
      hosts: results,
    };
    const updated = await updateLro({
      op_id: op.op_id,
      status: "succeeded",
      progress_summary: {
        phase: "done",
        message: "paced runtime fleet rollout complete",
        version,
        components,
        completed: hostIds.length,
        total: hostIds.length,
        progress: 100,
        hosts: results,
        recovery_stop_gate_baseline: recoveryStopGateBaseline,
        recovery_stop_gate_latest: recoveryStopGateLatest,
        recovery_stop_gate_passed_host_ids: Array.from(gatedHostIds),
      },
      result,
      error: null,
    });
    if (updated)
      await publishLroSummary({
        scope_type: updated.scope_type,
        scope_id: updated.scope_id,
        summary: updated,
      });
  } catch (err) {
    const latest = await getLro(op.op_id);
    const canceled = latest?.status === "canceled";
    const updated = await updateLro({
      op_id: op.op_id,
      status: canceled ? "canceled" : "failed",
      progress_summary: {
        phase: canceled ? "canceled" : "paused",
        message: `${err instanceof Error ? err.message : err}`,
        version,
        components,
        completed: Array.from(resultByHost.values()).filter(
          (result) => result.status === "succeeded",
        ).length,
        total: hostIds.length,
        hosts: Array.from(resultByHost.values()),
        recovery_stop_gate_baseline: recoveryStopGateBaseline,
        recovery_stop_gate_latest: recoveryStopGateLatest,
        recovery_stop_gate_passed_host_ids: Array.from(gatedHostIds),
      },
      error: `${err instanceof Error ? err.message : err}`,
    });
    if (updated)
      await publishLroSummary({
        scope_type: updated.scope_type,
        scope_id: updated.scope_id,
        summary: updated,
      });
  } finally {
    clearInterval(heartbeat);
  }
}

let running = false;
let inFlight = false;

export function startHostRuntimeFleetRolloutWorker({
  intervalMs = TICK_MS,
}: {
  intervalMs?: number;
} = {}) {
  if (running) return () => undefined;
  running = true;
  const tick = async () => {
    if (inFlight) return;
    let ops: LroSummary[] = [];
    try {
      ops = await claimLroOps({
        kind: KIND,
        owner_type: OWNER_TYPE,
        owner_id: OWNER_ID,
        limit: 1,
        lease_ms: LEASE_MS,
      });
    } catch (err) {
      logger.warn("fleet rollout claim failed", { err: `${err}` });
      return;
    }
    for (const op of ops) {
      inFlight = true;
      void handleRollout(op)
        .catch(async (err) => {
          logger.error("fleet rollout worker failed", {
            op_id: op.op_id,
            err: `${err}`,
          });
          const updated = await updateLro({
            op_id: op.op_id,
            status: "failed",
            error: `${err}`,
          });
          if (updated)
            await publishLroSummary({
              scope_type: updated.scope_type,
              scope_id: updated.scope_id,
              summary: updated,
            });
        })
        .finally(() => {
          inFlight = false;
        });
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return () => {
    clearInterval(timer);
    running = false;
    inFlight = false;
  };
}

export const __test__ = {
  buildRolloutWaves,
  componentRuntimeVersionsForPromotion,
  normalizedRolloutComponents,
  runtimeDeploymentsForPromotion,
  runtimeObservationIsStable,
  recoveryStopGateFailure,
  savedRecoveryStopGateBaseline,
};
