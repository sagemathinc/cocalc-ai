/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { ensureProjectHostRuntimeDeploymentsSchema } from "@cocalc/database/postgres/project-host-runtime-deployments";
import type { ManagedComponentKind } from "@cocalc/conat/project-host/api";
import { runtimeFleetDeploymentTargetKeys } from "./runtime-fleet-overrides";

export const HOST_RUNTIME_FLEET_ROLLOUT_KIND = "host-runtime-fleet-rollout";

// A paused fleet campaign is stale once deployment intent for its targets has
// moved on without it: resuming would deploy its version to the hosts it had
// not finished and could promote that version globally over newer intent.
// Since the campaign was created, it is superseded by
// - any newer fleet campaign;
// - any change to the global row of one of its targets (a paused campaign has
//   not promoted yet, so it never wrote those rows itself);
// - any change, to another version, of a host row for one of its targets on a
//   host it has not finished (its own upgrade of a failed host writes rows at
//   its own version).
// The resume API checks this, and the worker checks it again when a resumed
// campaign starts and before it promotes, so a direct `deploy set` that races
// the resume is still caught.
export async function fleetCampaignSupersededReason({
  op_id,
  version,
  components,
  host_ids,
  completed_host_ids,
}: {
  op_id: string;
  version: string;
  components: ManagedComponentKind[];
  host_ids: string[];
  completed_host_ids: string[];
}): Promise<string | undefined> {
  const pool = getPool();
  const { rows: newer } = await pool.query(
    `SELECT op_id, status
       FROM long_running_operations
      WHERE kind = $1
        AND op_id <> $2
        AND created_at > (SELECT created_at FROM long_running_operations WHERE op_id = $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [HOST_RUNTIME_FLEET_ROLLOUT_KIND, op_id],
  );
  if (newer.length) {
    return `a newer fleet rollout ${newer[0].op_id} (${newer[0].status}) was created after it`;
  }
  const targetKeys = runtimeFleetDeploymentTargetKeys(components);
  const completed = new Set(completed_host_ids);
  const pending = host_ids.filter((host_id) => !completed.has(host_id));
  await ensureProjectHostRuntimeDeploymentsSchema();
  const { rows: moved } = await pool.query(
    `SELECT scope_type, host_id, target_type, target, desired_version
       FROM project_host_runtime_deployments
      WHERE (target_type || ':' || target) = ANY($1::text[])
        AND updated_at > (SELECT created_at FROM long_running_operations WHERE op_id = $2)
        AND (
          scope_type = 'global'
          OR (
            scope_type = 'host'
            AND host_id::text = ANY($3::text[])
            AND desired_version <> $4
          )
        )
      ORDER BY scope_type, target_type, target
      LIMIT 1`,
    [targetKeys, op_id, pending, version],
  );
  if (moved.length) {
    const row = moved[0];
    const scope =
      row.scope_type === "global" ? "global default" : `host ${row.host_id}`;
    return `the ${scope} for ${row.target_type}:${row.target} changed to ${row.desired_version} after it was created`;
  }
  return undefined;
}
