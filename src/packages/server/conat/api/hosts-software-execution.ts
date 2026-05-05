/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host software upgrade and managed-component rollout execution helpers.

What belongs here:

- the side-effecting execution flow for host software upgrades
- the side-effecting execution flow for managed-component rollouts
- the project-host-specific post-rollout checks that detect local rollback and
  record last-known-good versions

What does not belong here:

- public API handler entrypoints
- LRO enqueue / orchestration
- host status observation
- generic host lifecycle operations

`hosts.ts` keeps the public wrappers and dependency wiring while this module
contains the execution logic itself.
*/

import type {
  HostSoftwareChannel,
  HostSoftwareArtifact,
  HostSoftwareUpgradeResponse,
  HostSoftwareUpgradeTarget,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostAgentStatus,
  HostManagedComponentRolloutRequest,
  HostManagedComponentRolloutResponse,
  HostManagedComponentStatus,
  HostRuntimeLogSource,
  HostRuntimeRetentionPolicy,
} from "@cocalc/conat/project-host/api";
import { installedProjectHostArtifactVersion } from "./hosts-runtime-observation";
import { defaultHostRuntimeRetentionPolicy } from "./hosts-runtime-retention-policy";
import { runtimeDeploymentsForAlignedProjectHostVersion } from "./hosts-runtime-deployment-planning";

const ROLLOUT_DIAGNOSTIC_LINES = 25;
const PROJECT_HOST_ROLLOUT_SETTLE_TIMEOUT_MS = 150_000;
const PROJECT_HOST_ROLLOUT_POLL_MS = 5_000;

const RUNTIME_LOG_SOURCE_BY_COMPONENT: Partial<
  Record<
    HostManagedComponentRolloutRequest["components"][number],
    HostRuntimeLogSource
  >
> = {
  "project-host": "project-host",
  "conat-router": "conat-router",
  "conat-persist": "conat-persist",
  "acp-worker": "acp-worker",
};

function uniqueRuntimeLogSourcesForComponents(
  components: HostManagedComponentRolloutRequest["components"],
): HostRuntimeLogSource[] {
  const requested = new Set<HostRuntimeLogSource>(["supervision-events"]);
  for (const component of components) {
    const source = RUNTIME_LOG_SOURCE_BY_COMPONENT[component];
    if (source) requested.add(source);
  }
  return [...requested];
}

function trimRuntimeLogText(text?: string): string | undefined {
  const normalized = `${text ?? ""}`.trim();
  return normalized || undefined;
}

function normalizeObservedVersion(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value}`;
  }
  return undefined;
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

async function resolveBootstrapUpgradeVersion({
  target,
  resolvedBaseUrl,
}: {
  target: HostSoftwareUpgradeTarget;
  resolvedBaseUrl?: string;
}): Promise<string> {
  const explicit = `${target.version ?? ""}`.trim();
  if (explicit) return explicit;
  const channel = (
    target.channel === "staging" ? "staging" : "latest"
  ) as HostSoftwareChannel;
  if (!resolvedBaseUrl) {
    return channel;
  }
  const shaUrl = `${resolvedBaseUrl.replace(/\/+$/, "")}/bootstrap/${channel}/bootstrap.py.sha256`;
  try {
    const text = await fetchTextWithTimeout(shaUrl, 8_000);
    const sha = text.trim().split(/\s+/)[0];
    return sha || channel;
  } catch {
    return channel;
  }
}

type DirectHostSoftwareArtifact = Exclude<
  HostSoftwareArtifact,
  "bootstrap-environment"
>;

type DirectHostSoftwareUpgradeTarget = Omit<
  HostSoftwareUpgradeTarget,
  "artifact"
> & {
  artifact: DirectHostSoftwareArtifact;
};

function observedInstalledProjectHostVersionFromRow(
  row: any,
): string | undefined {
  const inventoryVersion = Array.isArray(row?.metadata?.software_inventory)
    ? row.metadata.software_inventory.find(
        (entry: any) => `${entry?.artifact ?? ""}`.trim() === "project-host",
      )?.current_version
    : undefined;
  const lifecycleInstalled = Array.isArray(
    row?.metadata?.bootstrap_lifecycle?.items,
  )
    ? row.metadata.bootstrap_lifecycle.items.find(
        (item: any) => `${item?.key ?? ""}`.trim() === "project_host_bundle",
      )?.installed
    : undefined;
  return (
    normalizeObservedVersion(inventoryVersion) ??
    normalizeObservedVersion(lifecycleInstalled)
  );
}

function observedInstalledProjectHostBuildIdFromRow(
  row: any,
): string | undefined {
  const inventoryBuildId = Array.isArray(row?.metadata?.software_inventory)
    ? row.metadata.software_inventory.find(
        (entry: any) => `${entry?.artifact ?? ""}`.trim() === "project-host",
      )?.current_build_id
    : undefined;
  return (
    normalizeObservedVersion(inventoryBuildId) ??
    normalizeObservedVersion(row?.metadata?.software?.project_host_build_id)
  );
}

function normalizeObservedProjectHostRolloutVersion({
  row,
  desiredVersion,
  observedVersion,
}: {
  row: any;
  desiredVersion?: string;
  observedVersion?: string;
}): string | undefined {
  const normalized = normalizeObservedVersion(observedVersion);
  if (!normalized) return undefined;
  const currentVersion = observedInstalledProjectHostVersionFromRow(row);
  const currentBuildId = observedInstalledProjectHostBuildIdFromRow(row);
  if (
    desiredVersion &&
    currentVersion === desiredVersion &&
    currentBuildId &&
    normalized === currentBuildId
  ) {
    return desiredVersion;
  }
  return normalized;
}

function observedRunningProjectHostVersion(
  statuses?: HostManagedComponentStatus[],
): string | undefined {
  const projectHost = (statuses ?? []).find(
    (status) => status.component === "project-host",
  );
  const versions = [
    ...new Set(
      (projectHost?.running_versions ?? [])
        .map((version) => normalizeObservedVersion(version))
        .filter((version): version is string => version != null),
    ),
  ];
  return versions.length === 1 ? versions[0] : undefined;
}

function projectHostRollbackVersionFromHostAgent({
  hostAgentStatus,
  desiredVersion,
}: {
  hostAgentStatus?: HostAgentStatus;
  desiredVersion?: string;
}): string | undefined {
  const targetVersion = normalizeObservedVersion(
    hostAgentStatus?.project_host?.last_automatic_rollback?.target_version,
  );
  if (!desiredVersion || targetVersion !== desiredVersion) {
    return undefined;
  }
  return normalizeObservedVersion(
    hostAgentStatus?.project_host?.last_automatic_rollback?.rollback_version,
  );
}

function projectHostPendingRolloutMatches({
  hostAgentStatus,
  desiredVersion,
}: {
  hostAgentStatus?: HostAgentStatus;
  desiredVersion?: string;
}): boolean {
  const targetVersion = normalizeObservedVersion(
    hostAgentStatus?.project_host?.pending_rollout?.target_version,
  );
  return !!desiredVersion && targetVersion === desiredVersion;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveDesiredProjectHostVersion({
  row,
  loadEffectiveRuntimeDeployments,
}: {
  row: any;
  loadEffectiveRuntimeDeployments: (opts: {
    host_id: string;
  }) => Promise<
    Array<{ target_type: string; target: string; desired_version?: string }>
  >;
}): Promise<string | undefined> {
  const effective = await loadEffectiveRuntimeDeployments({ host_id: row.id });
  const desiredFromRuntimeDeployments = effective.find(
    (record) =>
      record.target_type === "artifact" && record.target === "project-host",
  )?.desired_version;
  return (
    (normalizeObservedVersion(desiredFromRuntimeDeployments) ??
      `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim()) ||
    undefined
  );
}

async function enrichManagedComponentRolloutError({
  err,
  client,
  components,
}: {
  err: unknown;
  client: {
    getRuntimeLog: (opts: {
      lines?: number;
      source?: HostRuntimeLogSource;
    }) => Promise<{ source: string; lines: number; text: string }>;
  };
  components: HostManagedComponentRolloutRequest["components"];
}): Promise<Error> {
  const sections: string[] = [];
  for (const source of uniqueRuntimeLogSourcesForComponents(components)) {
    try {
      const log = await client.getRuntimeLog({
        source,
        lines: ROLLOUT_DIAGNOSTIC_LINES,
      });
      const text = trimRuntimeLogText(log.text);
      if (!text) continue;
      sections.push(`[${source}]\n${text}`);
    } catch {
      continue;
    }
  }
  const message =
    err instanceof Error ? err.message : `${err ?? "unknown rollout error"}`;
  if (!sections.length) {
    return err instanceof Error ? err : new Error(message);
  }
  const enriched = new Error(
    `${message}\n\nRecent host diagnostics:\n${sections.join("\n\n")}`,
  );
  if (err instanceof Error) {
    (enriched as Error & { cause?: Error }).cause = err;
  }
  return enriched;
}

export async function upgradeHostSoftwareInternalHelper({
  account_id,
  id,
  targets,
  base_url,
  align_runtime_stack,
  loadHostForStartStop,
  assertHostRunningForUpgrade,
  computeHostOperationalAvailability,
  resolveHostSoftwareBaseUrl,
  resolveReachableUpgradeBaseUrl,
  logWarn,
  reconcileCloudHostBootstrapOverSsh,
  hostControlClient,
  updateProjectHostSoftwareRecord,
  runtimeDeploymentsForUpgradeResults,
  requestedByForRuntimeDeployments,
  setProjectHostRuntimeDeployments,
}: {
  account_id?: string;
  id: string;
  targets: HostSoftwareUpgradeTarget[];
  base_url?: string;
  align_runtime_stack?: boolean;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  assertHostRunningForUpgrade: (row: any) => void;
  computeHostOperationalAvailability: (row: any) => {
    online: boolean;
    reason_unavailable?: string;
  };
  resolveHostSoftwareBaseUrl: (
    base_url?: string,
  ) => Promise<string | undefined>;
  resolveReachableUpgradeBaseUrl: (opts: {
    row: any;
    baseUrl?: string;
  }) => Promise<string | undefined>;
  logWarn: (message: string, payload: Record<string, any>) => void;
  reconcileCloudHostBootstrapOverSsh: (opts: {
    host_id: string;
    row: any;
  }) => Promise<void>;
  hostControlClient: (
    id: string,
    timeout_ms: number,
  ) => Promise<{
    upgradeSoftware: (opts: {
      targets: DirectHostSoftwareUpgradeTarget[];
      base_url?: string;
      restart_project_host: boolean;
      retention_policy?: HostRuntimeRetentionPolicy;
    }) => Promise<HostSoftwareUpgradeResponse>;
  }>;
  updateProjectHostSoftwareRecord: (opts: {
    row: any;
    results: NonNullable<HostSoftwareUpgradeResponse["results"]>;
  }) => Promise<void>;
  runtimeDeploymentsForUpgradeResults: (
    results: HostSoftwareUpgradeResponse["results"],
    opts?: {
      alignRuntimeStack?: boolean;
      alignedProjectHostVersion?: string;
    },
  ) => any[];
  requestedByForRuntimeDeployments: (opts: {
    account_id?: string;
    row: any;
  }) => string;
  setProjectHostRuntimeDeployments: (opts: {
    scope_type: "host";
    host_id: string;
    requested_by: string;
    deployments: any[];
    replace: boolean;
  }) => Promise<any>;
}): Promise<HostSoftwareUpgradeResponse> {
  const HOST_UPGRADE_RPC_TIMEOUT_MS = 10 * 60 * 1000;
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const bootstrapTargets = targets.filter(
    (target) => target.artifact === "bootstrap-environment",
  );
  const directTargets = targets.filter(
    (target): target is DirectHostSoftwareUpgradeTarget =>
      target.artifact !== "bootstrap-environment",
  );
  const availability = computeHostOperationalAvailability(row);
  const requestedProjectHostUpgrade = directTargets.some(
    (target) => target.artifact === "project-host",
  );
  const supportsBootstrapFallback =
    requestedProjectHostUpgrade &&
    directTargets.every(
      (target) =>
        !target.version &&
        ((target.channel ?? "latest") as HostSoftwareChannel) === "latest",
    );
  const resolvedBaseUrl = await resolveHostSoftwareBaseUrl(base_url);
  const effectiveBaseUrl = await resolveReachableUpgradeBaseUrl({
    row,
    baseUrl: resolvedBaseUrl,
  });
  const bootstrapRuntimeDeployments = await Promise.all(
    bootstrapTargets.map(async (target) => ({
      target_type: "artifact" as const,
      target: "bootstrap-environment" as const,
      desired_version: await resolveBootstrapUpgradeVersion({
        target,
        resolvedBaseUrl,
      }),
    })),
  );
  if (!availability.online && supportsBootstrapFallback) {
    logWarn(
      "host upgrade: host heartbeat is stale; using bootstrap reconcile fallback",
      {
        host_id: id,
        targets,
        reason: availability.reason_unavailable,
      },
    );
    await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
    return { results: [] };
  }
  const client = await hostControlClient(id, HOST_UPGRADE_RPC_TIMEOUT_MS);
  let response: HostSoftwareUpgradeResponse;
  try {
    response =
      directTargets.length > 0
        ? await client.upgradeSoftware({
            targets: directTargets,
            base_url: effectiveBaseUrl,
            restart_project_host: false,
            retention_policy: await defaultHostRuntimeRetentionPolicy(),
          })
        : { results: [] };
  } catch (err) {
    if (!supportsBootstrapFallback) {
      throw err;
    }
    logWarn("host upgrade: host control upgrade failed; retry via ssh", {
      host_id: id,
      targets,
      err: `${err}`,
    });
    await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
    return { results: [] };
  }
  const results = [
    ...(response.results ?? []),
    ...bootstrapRuntimeDeployments.map((deployment) => ({
      artifact: deployment.target,
      version: deployment.desired_version,
      status: "updated" as const,
    })),
  ];
  if (results.length) {
    await updateProjectHostSoftwareRecord({ row, results });
  }
  const explicitProjectHostTarget = targets.find(
    (target) =>
      target.artifact === "project-host" &&
      `${target.version ?? ""}`.trim().length > 0,
  );
  const refreshedRowForProjectHostVersion =
    align_runtime_stack && requestedProjectHostUpgrade
      ? explicitProjectHostTarget == null || results.length > 0
        ? await loadHostForStartStop(id, account_id)
        : row
      : undefined;
  const alignedProjectHostVersion =
    `${explicitProjectHostTarget?.version ?? ""}`.trim() ||
    installedProjectHostArtifactVersion(refreshedRowForProjectHostVersion);
  const runtimeDeployments = runtimeDeploymentsForUpgradeResults(results, {
    alignRuntimeStack: align_runtime_stack,
    alignedProjectHostVersion,
  });
  const hasAlignedProjectHostRuntimeTargets = runtimeDeployments.some(
    (deployment) =>
      deployment.target_type === "component" &&
      deployment.target === "project-host",
  );
  if (
    align_runtime_stack &&
    requestedProjectHostUpgrade &&
    !hasAlignedProjectHostRuntimeTargets
  ) {
    const desiredProjectHostVersion =
      alignedProjectHostVersion ||
      installedProjectHostArtifactVersion(
        refreshedRowForProjectHostVersion ?? row,
      );
    runtimeDeployments.push(
      ...runtimeDeploymentsForAlignedProjectHostVersion({
        version: desiredProjectHostVersion,
        rolloutReason: "project_host_align_runtime_stack",
      }),
    );
  }
  if (runtimeDeployments.length) {
    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
      requested_by: requestedByForRuntimeDeployments({ account_id, row }),
      deployments: runtimeDeployments,
      replace: false,
    });
  }
  if (bootstrapRuntimeDeployments.length > 0) {
    await reconcileCloudHostBootstrapOverSsh({ host_id: id, row });
  }
  return { results };
}

export async function rolloutHostManagedComponentsInternalHelper({
  account_id,
  id,
  components,
  reason,
  loadHostForStartStop,
  assertHostRunningForUpgrade,
  hostControlClient,
  waitForHostHeartbeatAfter,
  installedProjectHostArtifactVersion,
  recordProjectHostLocalRollbackInternal,
  project_host_local_rollback_error_code,
  setLastKnownGoodArtifactVersionInternal,
  runtimeDeploymentsForComponentRollout,
  requestedByForRuntimeDeployments,
  setProjectHostRuntimeDeployments,
  loadEffectiveRuntimeDeployments,
  projectHostRolloutSettleTimeoutMs = PROJECT_HOST_ROLLOUT_SETTLE_TIMEOUT_MS,
  projectHostRolloutPollMs = PROJECT_HOST_ROLLOUT_POLL_MS,
}: {
  account_id?: string;
  id: string;
  components: HostManagedComponentRolloutRequest["components"];
  reason?: string;
  loadHostForStartStop: (id: string, account_id?: string) => Promise<any>;
  assertHostRunningForUpgrade: (row: any) => void;
  hostControlClient: (
    id: string,
    timeout_ms: number,
  ) => Promise<{
    getRuntimeLog: (opts: {
      lines?: number;
      source?: HostRuntimeLogSource;
    }) => Promise<{ source: string; lines: number; text: string }>;
    rolloutManagedComponents: (opts: {
      components: HostManagedComponentRolloutRequest["components"];
      reason?: string;
    }) => Promise<HostManagedComponentRolloutResponse>;
    getManagedComponentStatus?: () => Promise<HostManagedComponentStatus[]>;
    getHostAgentStatus?: () => Promise<HostAgentStatus>;
  }>;
  waitForHostHeartbeatAfter: (opts: {
    host_id: string;
    since: number;
  }) => Promise<void>;
  installedProjectHostArtifactVersion: (row: any) => string | undefined;
  recordProjectHostLocalRollbackInternal: (opts: {
    account_id?: string;
    id: string;
    version: string;
    reason?: string;
  }) => Promise<{
    host_id: string;
    rollback_version: string;
    source: "host-agent";
  }>;
  project_host_local_rollback_error_code: string;
  setLastKnownGoodArtifactVersionInternal: (opts: {
    host_id: string;
    row: any;
    artifact: "project-host";
    version?: string;
  }) => Promise<void>;
  runtimeDeploymentsForComponentRollout: (opts: {
    components: HostManagedComponentRolloutRequest["components"];
    desired_version?: string;
    reason?: string;
  }) => any[];
  requestedByForRuntimeDeployments: (opts: {
    account_id?: string;
    row: any;
  }) => string;
  setProjectHostRuntimeDeployments: (opts: {
    scope_type: "host";
    host_id: string;
    requested_by: string;
    deployments: any[];
    replace: false;
  }) => Promise<any>;
  loadEffectiveRuntimeDeployments: (opts: {
    host_id: string;
  }) => Promise<
    Array<{ target_type: string; target: string; desired_version?: string }>
  >;
  projectHostRolloutSettleTimeoutMs?: number;
  projectHostRolloutPollMs?: number;
}): Promise<HostManagedComponentRolloutResponse> {
  const row = await loadHostForStartStop(id, account_id);
  assertHostRunningForUpgrade(row);
  const requestedProjectHostRollout = components.includes("project-host");
  const client = await hostControlClient(id, 60_000);
  const rolloutStartedAt = Date.now();
  let response: HostManagedComponentRolloutResponse;
  try {
    response = await client.rolloutManagedComponents({
      components,
      reason,
    });
  } catch (err) {
    throw await enrichManagedComponentRolloutError({
      err,
      client,
      components,
    });
  }
  let refreshedRow = row;
  if (requestedProjectHostRollout) {
    const baselineSeen = row?.last_seen
      ? new Date(row.last_seen as any).getTime()
      : 0;
    const since = Math.max(baselineSeen, rolloutStartedAt);
    await waitForHostHeartbeatAfter({ host_id: id, since });
    refreshedRow = await loadHostForStartStop(id, account_id);
  }
  const desiredVersion = requestedProjectHostRollout
    ? await resolveDesiredProjectHostVersion({
        row,
        loadEffectiveRuntimeDeployments,
      })
    : undefined;
  let observedProjectHostVersion: string | undefined;
  let fallbackProjectHostVersion: string | undefined;
  let projectHostRollbackVersion: string | undefined;
  let pendingProjectHostRollout = false;
  const refreshProjectHostObservation = async () => {
    let statusClient:
      | Awaited<ReturnType<typeof hostControlClient>>
      | undefined = undefined;
    let runningVersion: string | undefined;
    let hostAgentStatus: HostAgentStatus | undefined;
    try {
      statusClient = await hostControlClient(id, 30_000);
      if (typeof statusClient.getManagedComponentStatus === "function") {
        runningVersion = observedRunningProjectHostVersion(
          await statusClient.getManagedComponentStatus(),
        );
      }
      if (typeof statusClient.getHostAgentStatus === "function") {
        hostAgentStatus = await statusClient.getHostAgentStatus();
      }
    } catch {
      // The host control RPC can still be coming back after project-host
      // restart; fall back to bootstrap/runtime observations in that case.
    }
    observedProjectHostVersion = normalizeObservedProjectHostRolloutVersion({
      row: refreshedRow,
      desiredVersion,
      observedVersion:
        runningVersion ??
        observedInstalledProjectHostVersionFromRow(refreshedRow),
    });
    fallbackProjectHostVersion = normalizeObservedProjectHostRolloutVersion({
      row: refreshedRow,
      desiredVersion,
      observedVersion: installedProjectHostArtifactVersion(refreshedRow),
    });
    projectHostRollbackVersion = projectHostRollbackVersionFromHostAgent({
      hostAgentStatus,
      desiredVersion,
    });
    pendingProjectHostRollout = projectHostPendingRolloutMatches({
      hostAgentStatus,
      desiredVersion,
    });
  };
  await refreshProjectHostObservation();
  if (requestedProjectHostRollout && desiredVersion) {
    const settleStartedAt = Date.now();
    while (
      projectHostRollbackVersion == null &&
      observedProjectHostVersion !== desiredVersion &&
      Date.now() - settleStartedAt < projectHostRolloutSettleTimeoutMs
    ) {
      if (
        !pendingProjectHostRollout &&
        observedProjectHostVersion &&
        observedProjectHostVersion !== desiredVersion &&
        fallbackProjectHostVersion !== desiredVersion
      ) {
        break;
      }
      await delay(projectHostRolloutPollMs);
      refreshedRow = await loadHostForStartStop(id, account_id);
      await refreshProjectHostObservation();
    }
    if (projectHostRollbackVersion) {
      const automaticRollback = await recordProjectHostLocalRollbackInternal({
        account_id,
        id,
        version: projectHostRollbackVersion,
        reason: "automatic_project_host_local_rollback",
      });
      const err = Object.assign(
        new Error(
          `project-host rollout converged to ${projectHostRollbackVersion} instead of desired ${desiredVersion}`,
        ),
        {
          code: project_host_local_rollback_error_code,
          automaticRollback,
        },
      );
      throw err;
    }
    if (
      observedProjectHostVersion &&
      observedProjectHostVersion !== desiredVersion
    ) {
      throw new Error(
        `project-host rollout did not converge to desired ${desiredVersion}; observed ${observedProjectHostVersion}`,
      );
    }
    await setLastKnownGoodArtifactVersionInternal({
      host_id: refreshedRow.id,
      row: refreshedRow,
      artifact: "project-host",
      version:
        observedProjectHostVersion ??
        fallbackProjectHostVersion ??
        desiredVersion,
    });
  }
  const runtimeDeployments = runtimeDeploymentsForComponentRollout({
    components,
    desired_version: desiredVersion,
    reason,
  });
  if (runtimeDeployments.length) {
    await setProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
      requested_by: requestedByForRuntimeDeployments({ account_id, row }),
      deployments: runtimeDeployments,
      replace: false,
    });
  }
  return response;
}
