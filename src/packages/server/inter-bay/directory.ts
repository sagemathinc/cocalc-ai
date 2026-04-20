/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  createInterBayDirectoryClient,
  type BayOwnership,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterBayIdsForStaticEnumerationOnly } from "@cocalc/server/cluster-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const LOCAL_EPOCH = 0;
const DIRECTORY_FALLBACK_TIMEOUT_MS = 2_000;

export async function resolveProjectBay(
  project_id: string,
): Promise<BayOwnership | null> {
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).resolveProjectBay({ project_id });
}

export async function resolveProjectBayDirect(
  project_id: string,
): Promise<BayOwnership | null> {
  const defaultBayId = getConfiguredBayId();
  const { rows } = await getPool().query<{
    bay_id: string | null;
  }>(
    `
      SELECT COALESCE(owning_bay_id, $2) AS bay_id
      FROM projects
      WHERE project_id = $1
    `,
    [project_id, defaultBayId],
  );
  const bay_id = `${rows[0]?.bay_id ?? ""}`.trim();
  if (!bay_id) {
    return null;
  }
  return { bay_id, epoch: LOCAL_EPOCH };
}

export async function resolveProjectBayAcrossCluster(
  project_id: string,
): Promise<BayOwnership | null> {
  const local = await resolveProjectBayDirect(project_id);
  if (local != null) {
    return local;
  }
  // This is a miss-path fallback, not the intended steady-state cluster
  // directory design. It keeps attached-bay-owned projects resolvable now,
  // but the long-term fix should be a cluster-wide index or broadcast-style
  // lookup rather than sequential fanout across bays.
  const currentBayId = getConfiguredBayId();
  for (const bay_id of getConfiguredClusterBayIdsForStaticEnumerationOnly()) {
    if (!bay_id || bay_id === currentBayId) {
      continue;
    }
    try {
      const remote = await getInterBayBridge()
        .directory(bay_id, {
          timeout_ms: DIRECTORY_FALLBACK_TIMEOUT_MS,
        })
        .resolveProjectBay({ project_id });
      if (remote != null) {
        return remote;
      }
    } catch {
      // Best effort fallback only. Unreachable bays should not break lookups
      // for projects owned elsewhere in the cluster.
    }
  }
  return null;
}

export async function resolveHostBay(
  host_id: string,
): Promise<BayOwnership | null> {
  return await createInterBayDirectoryClient({
    client: getInterBayFabricClient(),
  }).resolveHostBay({ host_id });
}

export async function resolveHostBayDirect(
  host_id: string,
): Promise<BayOwnership | null> {
  const defaultBayId = getConfiguredBayId();
  const { rows } = await getPool().query<{
    bay_id: string | null;
  }>(
    `
      SELECT COALESCE(bay_id, $2) AS bay_id
      FROM project_hosts
      WHERE id = $1
        AND deleted IS NULL
    `,
    [host_id, defaultBayId],
  );
  const bay_id = `${rows[0]?.bay_id ?? ""}`.trim();
  if (!bay_id) {
    return null;
  }
  return { bay_id, epoch: LOCAL_EPOCH };
}

export async function resolveHostBayAcrossCluster(
  host_id: string,
): Promise<BayOwnership | null> {
  const local = await resolveHostBayDirect(host_id);
  if (local != null) {
    return local;
  }
  // Same tradeoff as resolveProjectBayAcrossCluster: this is only a bounded
  // fallback path until we have a better cluster-wide ownership directory.
  const currentBayId = getConfiguredBayId();
  for (const bay_id of getConfiguredClusterBayIdsForStaticEnumerationOnly()) {
    if (!bay_id || bay_id === currentBayId) {
      continue;
    }
    try {
      const remote = await getInterBayBridge()
        .directory(bay_id, {
          timeout_ms: DIRECTORY_FALLBACK_TIMEOUT_MS,
        })
        .resolveHostBay({ host_id });
      if (remote != null) {
        return remote;
      }
    } catch {
      // Best effort fallback only.
    }
  }
  return null;
}
