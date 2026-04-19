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
  HostSoftwareUpgradeResponse,
  HostSoftwareUpgradeTarget,
} from "@cocalc/conat/hub/api/hosts";
import type {
  HostManagedComponentRolloutRequest,
  HostManagedComponentRolloutResponse,
  HostRuntimeLogSource,
  HostRuntimeRetentionPolicy,
} from "@cocalc/conat/project-host/api";
import { installedProjectHostArtifactVersion } from "./hosts-runtime-observation";
import { defaultHostRuntimeRetentionPolicy } from "./hosts-runtime-retention-policy";
import { runtimeDeploymentsForAlignedProjectHostVersion } from "./hosts-runtime-deployment-planning";

const ROLLOUT_DIAGNOSTIC_LINES = 25;

const RUNTIME_LOG_SOURCE_BY_COMPONENT: Partial<
  Record<
    HostManagedComponentRolloutRequest["components"][number],
    HostRuntimeLogSource
  >
> = {
  "project-host": "project-host",
  "conat-router": "conat-router",
  "conat-persist": "conat-persist",
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
      targets: HostSoftwareUpgradeTarget[];
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
    opts?: { alignRuntimeStack?: boolean },
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
  const availability = computeHostOperationalAvailability(row);
  const requestedProjectHostUpgrade = targets.some(
    (target) => target.artifact === "project-host",
  );
  const supportsBootstrapFallback =
    requestedProjectHostUpgrade &&
    targets.every(
      (target) =>
        !target.version &&
        ((target.channel ?? "latest") as HostSoftwareChannel) === "latest",
    );
  const resolvedBaseUrl = await resolveHostSoftwareBaseUrl(base_url);
  const effectiveBaseUrl = await resolveReachableUpgradeBaseUrl({
    row,
    baseUrl: resolvedBaseUrl,
  });
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
    response = await client.upgradeSoftware({
      targets,
      base_url: effectiveBaseUrl,
      restart_project_host: false,
      retention_policy: await defaultHostRuntimeRetentionPolicy(),
    });
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
  const results = response.results ?? [];
  if (results.length) {
    await updateProjectHostSoftwareRecord({ row, results });
  }
  const runtimeDeployments = runtimeDeploymentsForUpgradeResults(results, {
    alignRuntimeStack: align_runtime_stack,
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
    const explicitProjectHostTarget = targets.find(
      (target) =>
        target.artifact === "project-host" &&
        `${target.version ?? ""}`.trim().length > 0,
    );
    const refreshedRow =
      explicitProjectHostTarget == null || !results.length
        ? await loadHostForStartStop(id, account_id)
        : undefined;
    const desiredProjectHostVersion =
      `${explicitProjectHostTarget?.version ?? ""}`.trim() ||
      installedProjectHostArtifactVersion(refreshedRow ?? row);
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
  return response;
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
  const desiredVersion =
    `${row?.metadata?.software?.project_host ?? row?.version ?? ""}`.trim() ||
    undefined;
  const observedProjectHostVersion =
    installedProjectHostArtifactVersion(refreshedRow);
  if (requestedProjectHostRollout && desiredVersion) {
    if (
      observedProjectHostVersion &&
      observedProjectHostVersion !== desiredVersion
    ) {
      const automaticRollback = await recordProjectHostLocalRollbackInternal({
        account_id,
        id,
        version: observedProjectHostVersion,
        reason: "automatic_project_host_local_rollback",
      });
      const err = Object.assign(
        new Error(
          `project-host rollout converged to ${observedProjectHostVersion} instead of desired ${desiredVersion}`,
        ),
        {
          code: project_host_local_rollback_error_code,
          automaticRollback,
        },
      );
      throw err;
    }
    await setLastKnownGoodArtifactVersionInternal({
      host_id: refreshedRow.id,
      row: refreshedRow,
      artifact: "project-host",
      version: observedProjectHostVersion ?? desiredVersion,
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
