import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";

function pool() {
  return getPool();
}

export async function assertAccountProjectHostTokenProjectAccess({
  account_id,
  host_id,
  project_id,
}: {
  account_id: string;
  host_id: string;
  project_id: string;
}): Promise<void> {
  const { rows } = await pool().query<{
    host_id: string | null;
    project_owning_bay_id: string | null;
    group: string | null;
  }>(
    `
      SELECT
        host_id,
        COALESCE(projects.owning_bay_id, $3) AS project_owning_bay_id,
        users -> $2::text ->> 'group' AS "group"
      FROM projects
      WHERE project_id=$1
        AND projects.deleted IS NOT true
      LIMIT 1
    `,
    [project_id, account_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row) {
    const ownership = await resolveProjectBay(project_id);
    if (!ownership || ownership.bay_id === getConfiguredBayId()) {
      throw new Error("project not found");
    }
    const remote = await getInterBayBridge()
      .projectReference(ownership.bay_id)
      .get({ account_id, project_id });
    if (!remote) {
      throw new Error("not authorized for project-host access token");
    }
    if (remote.host_id !== host_id) {
      throw new Error("project is not assigned to the requested host");
    }
    return;
  }
  const remoteBayId = row.project_owning_bay_id;
  if (remoteBayId && remoteBayId !== getConfiguredBayId()) {
    const remote = await getInterBayBridge()
      .projectReference(remoteBayId, {
        timeout_ms: 15_000,
      })
      .get({ account_id, project_id });
    if (!remote) {
      throw new Error("not authorized for project-host access token");
    }
    if (remote.host_id !== host_id) {
      throw new Error("project is not assigned to the requested host");
    }
    return;
  }
  if (row.host_id !== host_id) {
    throw new Error("project is not assigned to the requested host");
  }
  if (row.group === "owner" || row.group === "collaborator") {
    return;
  }
  throw new Error("not authorized for project-host access token");
}

export async function hasAccountProjectHostTokenHostAccess({
  account_id,
  host_id,
}: {
  account_id: string;
  host_id: string;
}): Promise<boolean> {
  const { rowCount } = await pool().query(
    `
      SELECT 1
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE host_id=$1
        AND projects.deleted IS NOT true
        AND COALESCE(projects.owning_bay_id, $3) = COALESCE(project_hosts.bay_id, $3)
        AND (users -> $2::text ->> 'group') IN ('owner', 'collaborator')
      LIMIT 1
    `,
    [host_id, account_id, getConfiguredBayId()],
  );
  return !!rowCount;
}

export async function assertProjectHostAgentTokenAccess({
  host_id,
  account_id,
  project_id,
}: {
  host_id: string;
  account_id: string;
  project_id: string;
}): Promise<void> {
  if (!isValidUUID(host_id)) {
    throw new Error("host_id must be specified");
  }
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be specified");
  }
  if (!isValidUUID(project_id)) {
    throw new Error("project_id must be specified");
  }
  const { rowCount } = await pool().query(
    `
      SELECT 1
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE project_id=$1
        AND host_id=$2
        AND projects.deleted IS NOT true
        AND COALESCE(projects.owning_bay_id, $4) = COALESCE(project_hosts.bay_id, $4)
        AND (users -> $3::text ->> 'group') IN ('owner', 'collaborator')
      LIMIT 1
    `,
    [project_id, host_id, account_id, getConfiguredBayId()],
  );
  if (!rowCount) {
    throw new Error("not authorized for project-host agent auth token");
  }
}
