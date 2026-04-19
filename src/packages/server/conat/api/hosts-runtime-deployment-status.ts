/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Runtime deployment status loading and observation helpers for hosts.

What belongs here:

- read-only helpers that load runtime deployment configuration for a host
- read-only helpers that merge host metadata with live host-agent /
  managed-component observations into a deployment status snapshot
- small database reads used by automatic runtime deployment reconcile scans

What does not belong here:

- LRO creation
- automatic queueing loops
- reconcile / rollback side effects
- host lifecycle mutation

The goal is to keep the observation pipeline separate from the operational
flows in `hosts.ts`.
*/

import type {
  HostRuntimeDeploymentStatus,
  HostRuntimeDeploymentRecord,
} from "@cocalc/conat/hub/api/hosts";
import type { HostManagedComponentStatus } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";
import {
  listProjectHostRuntimeDeployments,
  loadEffectiveProjectHostRuntimeDeployments,
} from "@cocalc/database/postgres/project-host-runtime-deployments";
import {
  isUnsupportedHostAgentStatusObservationError,
  observedHostAgentFromMetadata,
  observedRuntimeArtifactsFromMetadata,
  summarizeObservedRuntimeDeployments,
  summarizeRollbackTargets,
} from "./hosts-runtime-observation";

type RuntimeStatusHostControlClient = {
  getManagedComponentStatus: () => Promise<HostManagedComponentStatus[]>;
  getInstalledRuntimeArtifacts: (opts?: {
    include_sizes?: boolean;
  }) => Promise<any[]>;
  getHostAgentStatus: () => Promise<any>;
};

function pool() {
  return getPool();
}

export async function loadHostRowForRuntimeDeploymentsInternal(
  host_id: string,
): Promise<any | undefined> {
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL LIMIT 1`,
    [host_id],
  );
  return rows[0];
}

export async function listRunningHostIdsForAutomaticRuntimeDeploymentReconcile({
  running_statuses,
}: {
  running_statuses: Set<string>;
}): Promise<string[]> {
  const { rows } = await pool().query<{ id: string }>(
    `SELECT id
     FROM project_hosts
     WHERE deleted IS NULL
       AND LOWER(COALESCE(status, '')) = ANY($1::text[])`,
    [[...running_statuses]],
  );
  return rows
    .map((row) => `${row?.id ?? ""}`.trim())
    .filter((id) => id.length > 0);
}

export async function getHostRuntimeDeploymentStatusInternal({
  id,
  row,
  running_statuses,
  hostControlClient,
}: {
  id: string;
  row: any;
  running_statuses: Set<string>;
  hostControlClient: (
    id: string,
    timeout_ms: number,
  ) => Promise<RuntimeStatusHostControlClient>;
}): Promise<HostRuntimeDeploymentStatus> {
  const [configured, effective] = await Promise.all([
    listProjectHostRuntimeDeployments({
      scope_type: "host",
      host_id: row.id,
    }),
    loadEffectiveProjectHostRuntimeDeployments({ host_id: row.id }),
  ]);
  let observed_artifacts = observedRuntimeArtifactsFromMetadata(row);
  let observed_components: HostManagedComponentStatus[] | undefined;
  let observed_host_agent = observedHostAgentFromMetadata(row);
  const observation_errors: string[] = [];
  if (running_statuses.has(`${row?.status ?? ""}`.toLowerCase())) {
    try {
      const client = await hostControlClient(id, 15_000);
      const [componentsResult, artifactsResult, hostAgentResult] =
        await Promise.allSettled([
          client.getManagedComponentStatus(),
          client.getInstalledRuntimeArtifacts({ include_sizes: true }),
          client.getHostAgentStatus(),
        ]);
      if (componentsResult.status === "fulfilled") {
        observed_components = componentsResult.value;
      } else {
        observation_errors.push(
          `components: ${componentsResult.reason?.message ?? componentsResult.reason}`,
        );
      }
      if (artifactsResult.status === "fulfilled") {
        observed_artifacts = observedRuntimeArtifactsFromMetadata({
          metadata: {
            software_inventory: artifactsResult.value,
            software: row?.metadata?.software,
          },
        });
      } else if (observed_artifacts.length === 0) {
        observation_errors.push(
          `artifacts: ${artifactsResult.reason?.message ?? artifactsResult.reason}`,
        );
      }
      if (hostAgentResult.status === "fulfilled") {
        observed_host_agent = observedHostAgentFromMetadata({
          metadata: {
            host_agent: hostAgentResult.value,
          },
        });
      } else if (
        !observed_host_agent &&
        !isUnsupportedHostAgentStatusObservationError(hostAgentResult.reason)
      ) {
        observation_errors.push(
          `host_agent: ${hostAgentResult.reason?.message ?? hostAgentResult.reason}`,
        );
      }
    } catch (err) {
      observation_errors.push(`${(err as Error)?.message ?? err}`);
    }
  } else {
    observation_errors.push("host is not currently running");
  }
  return {
    host_id: row.id,
    configured: configured as HostRuntimeDeploymentRecord[],
    effective: effective as HostRuntimeDeploymentRecord[],
    observed_artifacts,
    observed_components,
    observed_host_agent,
    observed_targets: summarizeObservedRuntimeDeployments({
      effective,
      observed_artifacts,
      observed_components,
    }),
    rollback_targets: summarizeRollbackTargets({
      row,
      effective,
      observed_artifacts,
      observed_components,
    }),
    observation_error: observation_errors.join("; ") || undefined,
  };
}
