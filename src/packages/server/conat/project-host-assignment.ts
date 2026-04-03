import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

function pool() {
  return getPool();
}

export const PROJECT_NOT_FOUND_ERROR = "project not found";
export const PROJECT_HAS_NO_ASSIGNED_HOST_ERROR =
  "project has no assigned host";
export const PROJECT_BAY_MISMATCH_ERROR =
  "project bay does not match assigned host";

export async function getAssignedProjectHostInfo(project_id: string): Promise<{
  host_id: string;
  ssh_server: string | null;
  metadata: any;
}> {
  const { rows } = await pool().query<{
    host_id: string | null;
    project_owning_bay_id: string | null;
    host_bay_id: string | null;
    ssh_server: string | null;
    metadata: any;
  }>(
    `
      SELECT
        projects.host_id,
        COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
        COALESCE(project_hosts.bay_id, $2) AS host_bay_id,
        project_hosts.ssh_server,
        project_hosts.metadata
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE projects.project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(PROJECT_NOT_FOUND_ERROR);
  }
  if (!row.host_id) {
    throw new Error(PROJECT_HAS_NO_ASSIGNED_HOST_ERROR);
  }
  if (row.project_owning_bay_id !== row.host_bay_id) {
    throw new Error(PROJECT_BAY_MISMATCH_ERROR);
  }
  return {
    host_id: row.host_id,
    ssh_server: row.ssh_server ?? null,
    metadata: row.metadata ?? {},
  };
}
