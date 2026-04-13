/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { ProjectReference } from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { materializeProjectHost } from "@cocalc/server/conat/route-project";
import {
  getLocalProjectCollaboratorAccessStatus,
  PROJECT_COLLABORATOR_REQUIRED_ERROR,
} from "@cocalc/server/conat/project-local-access";

async function loadLocalProjectReference({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectReference | null> {
  const { rows } = await getPool().query<{
    project_id: string;
    title: string | null;
    host_id: string | null;
    owning_bay_id: string | null;
    users: Record<string, any> | null;
  }>(
    `
      SELECT
        project_id,
        title,
        host_id,
        COALESCE(owning_bay_id, $3) AS owning_bay_id,
        COALESCE(users, '{}'::jsonb) AS users
      FROM projects
      WHERE project_id = $1
        AND deleted IS NOT TRUE
        AND users ? $2::text
      LIMIT 1
    `,
    [project_id, account_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row?.project_id) {
    return null;
  }
  return {
    project_id: row.project_id,
    title: row.title ?? "",
    host_id: row.host_id ?? null,
    owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
    users: row.users ?? {},
  };
}

async function warmProjectRoute(project_id: string): Promise<void> {
  try {
    await materializeProjectHost(project_id);
  } catch {
    // Best effort only. Remote collaborators may be routed through project-host
    // state that is not locally materialized on this bay yet.
  }
}

export async function resolveProjectReferenceAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<ProjectReference | null> {
  const access = await getLocalProjectCollaboratorAccessStatus({
    account_id,
    project_id,
  });
  if (access === "local-collaborator") {
    const local = await loadLocalProjectReference({ account_id, project_id });
    if (local != null) {
      await warmProjectRoute(project_id);
    }
    return local;
  }

  const ownership = await resolveProjectBay(project_id);
  if (!ownership || ownership.bay_id === getConfiguredBayId()) {
    return null;
  }
  const remote = await getInterBayBridge()
    .projectReference(ownership.bay_id)
    .get({ account_id, project_id });
  if (remote != null) {
    await warmProjectRoute(project_id);
  }
  return remote;
}

export async function hasProjectCollaboratorAccessAllowRemote({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<boolean> {
  return (
    (await resolveProjectReferenceAllowRemote({
      account_id,
      project_id,
    })) != null
  );
}

export async function assertProjectCollaboratorAccessAllowRemote({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<ProjectReference> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const reference = await resolveProjectReferenceAllowRemote({
    account_id,
    project_id,
  });
  if (reference == null) {
    throw Error(PROJECT_COLLABORATOR_REQUIRED_ERROR);
  }
  return reference;
}
