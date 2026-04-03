import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

function pool() {
  return getPool();
}

export async function shouldDeleteHostProjectUpdate({
  host_id,
  project_id,
}: {
  host_id: string;
  project_id: string;
}): Promise<boolean> {
  const { rows } = await pool().query<{
    current_host_id: string | null;
    project_owning_bay_id: string | null;
    host_bay_id: string | null;
  }>(
    `
      SELECT
        projects.host_id AS current_host_id,
        COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
        COALESCE(project_hosts.bay_id, $2) AS host_bay_id
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  const current_host_id = row?.current_host_id ?? null;
  if (!current_host_id) {
    return false;
  }
  if (current_host_id !== host_id) {
    return true;
  }
  return row?.project_owning_bay_id !== row?.host_bay_id;
}

export async function classifyHostProvisionedInventory({
  host_id,
  project_ids,
}: {
  host_id: string;
  project_ids: string[];
}): Promise<{
  accepted_project_ids: string[];
  delete_project_ids: string[];
}> {
  if (project_ids.length === 0) {
    return { accepted_project_ids: [], delete_project_ids: [] };
  }
  const { rows } = await pool().query<{
    project_id: string;
    current_host_id: string | null;
    project_owning_bay_id: string | null;
    host_bay_id: string | null;
  }>(
    `
      SELECT
        inv.project_id::text AS project_id,
        projects.host_id::text AS current_host_id,
        COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
        COALESCE(project_hosts.bay_id, $2) AS host_bay_id
      FROM unnest($1::text[]) AS inv(project_id)
      LEFT JOIN projects
        ON projects.project_id::text = inv.project_id
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
    `,
    [project_ids, getConfiguredBayId()],
  );
  const accepted_project_ids: string[] = [];
  const delete_project_ids: string[] = [];
  for (const row of rows) {
    if (
      row.current_host_id === host_id &&
      row.project_owning_bay_id === row.host_bay_id
    ) {
      accepted_project_ids.push(row.project_id);
    } else {
      delete_project_ids.push(row.project_id);
    }
  }
  return { accepted_project_ids, delete_project_ids };
}
