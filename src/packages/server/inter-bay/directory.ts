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
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const LOCAL_EPOCH = 0;

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
