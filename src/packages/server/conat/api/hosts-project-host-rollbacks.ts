/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Project-host version rewrite and rollback helpers for hosts.

What belongs here:

- database updates that rewrite the desired `project-host` artifact/component
  version for one host
- helpers that record last-known-good project-host artifact versions
- the mechanical steps of a local rollback marker or ssh-driven rollback once
  the caller has already loaded the host row and resolved authorization

What does not belong here:

- loading or authorizing hosts
- LRO creation
- broader runtime deployment planning
- generic host lifecycle orchestration

The goal is to isolate the project-host-specific write path from the larger
runtime deployment flow in `hosts.ts`.
*/

import type { HostRuntimeArtifact } from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import { setProjectHostRuntimeDeployments } from "@cocalc/database/postgres/project-host-runtime-deployments";
import { DEFAULT_RUNTIME_DEPLOYMENT_POLICY } from "./hosts-runtime-deployment-planning";

function pool() {
  return getPool();
}

export async function setLastKnownGoodArtifactVersionInternal({
  host_id,
  row,
  artifact,
  version,
}: {
  host_id: string;
  row: any;
  artifact: HostRuntimeArtifact;
  version?: string;
}): Promise<void> {
  const normalizedVersion = `${version ?? ""}`.trim();
  if (!normalizedVersion) return;
  const metadata = { ...(row?.metadata ?? {}) };
  const runtimeDeployments = { ...(metadata.runtime_deployments ?? {}) };
  const lastKnownGoodVersions = {
    ...(runtimeDeployments.last_known_good_versions ?? {}),
  };
  if (lastKnownGoodVersions[artifact] === normalizedVersion) return;
  lastKnownGoodVersions[artifact] = normalizedVersion;
  runtimeDeployments.last_known_good_versions = lastKnownGoodVersions;
  metadata.runtime_deployments = runtimeDeployments;
  await pool().query(
    `UPDATE project_hosts SET metadata=$2, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [host_id, metadata],
  );
}

export async function rewriteProjectHostDesiredVersionInternal({
  row,
  requested_by,
  version,
  reason,
}: {
  row: any;
  requested_by: string;
  version: string;
  reason?: string;
}): Promise<void> {
  const normalizedVersion = `${version ?? ""}`.trim();
  if (!normalizedVersion) {
    throw new Error("project-host version is required");
  }
  const metadata = { ...(row?.metadata ?? {}) };
  const software = { ...(metadata.software ?? {}) } as Record<string, string>;
  software.project_host = normalizedVersion;
  delete software.project_host_build_id;
  metadata.software = software;
  await pool().query(
    `UPDATE project_hosts SET metadata=$2, version=$3, updated=NOW() WHERE id=$1 AND deleted IS NULL`,
    [row.id, metadata, normalizedVersion],
  );
  await setLastKnownGoodArtifactVersionInternal({
    host_id: row.id,
    row: {
      ...row,
      metadata,
      version: normalizedVersion,
    },
    artifact: "project-host",
    version: normalizedVersion,
  });
  await setProjectHostRuntimeDeployments({
    scope_type: "host",
    host_id: row.id,
    requested_by,
    replace: false,
    deployments: [
      {
        target_type: "artifact",
        target: "project-host",
        desired_version: normalizedVersion,
        rollout_reason: reason,
      },
      {
        target_type: "component",
        target: "project-host",
        desired_version: normalizedVersion,
        rollout_policy: DEFAULT_RUNTIME_DEPLOYMENT_POLICY["project-host"],
        rollout_reason: reason,
      },
    ],
  });
}

export async function recordProjectHostLocalRollbackInternal({
  row,
  requested_by,
  version,
  reason,
}: {
  row: any;
  requested_by: string;
  version: string;
  reason?: string;
}): Promise<{
  host_id: string;
  rollback_version: string;
  source: "host-agent";
}> {
  const rollbackVersion = `${version ?? ""}`.trim();
  if (!rollbackVersion) {
    throw new Error("rollback version is required");
  }
  await rewriteProjectHostDesiredVersionInternal({
    row,
    requested_by,
    version: rollbackVersion,
    reason: reason || "automatic_project_host_local_rollback",
  });
  return {
    host_id: row.id,
    rollback_version: rollbackVersion,
    source: "host-agent",
  };
}

export async function rollbackProjectHostOverSshInternal({
  row,
  requested_by,
  version,
  reason,
  reconcileCloudHostBootstrapOverSsh,
}: {
  row: any;
  requested_by: string;
  version: string;
  reason?: string;
  reconcileCloudHostBootstrapOverSsh: (opts: {
    host_id: string;
    row: any;
  }) => Promise<void>;
}): Promise<{
  host_id: string;
  rollback_version: string;
}> {
  const rollbackVersion = `${version ?? ""}`.trim();
  if (!rollbackVersion) {
    throw new Error("rollback version is required");
  }
  await rewriteProjectHostDesiredVersionInternal({
    row,
    requested_by,
    version: rollbackVersion,
    reason,
  });
  const metadata = {
    ...(row?.metadata ?? {}),
    software: {
      ...((row?.metadata?.software ?? {}) as Record<string, string>),
      project_host: rollbackVersion,
    },
  };
  delete (metadata.software as Record<string, string>).project_host_build_id;
  await reconcileCloudHostBootstrapOverSsh({
    host_id: row.id,
    row: {
      ...row,
      version: rollbackVersion,
      metadata,
    },
  });
  return {
    host_id: row.id,
    rollback_version: rollbackVersion,
  };
}
