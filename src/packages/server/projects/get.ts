/* get up to limit projects that have the given user as a collaborator,
   ordered by how recently they were modified.

   DELETED and HIDDEN projects are skipped.
*/

import { listProjectedProjectsForAccount } from "@cocalc/database/postgres/account-project-index";
import type { AccountProjectIndexProjectListSort } from "@cocalc/database/postgres/account-project-index";
import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";

export interface DBProject {
  project_id: string;
  title?: string;
  description?: string;
}

type ProjectListReadMode = "off" | "prefer" | "only";

function getProjectListReadMode(): ProjectListReadMode {
  const raw =
    `${process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS ?? ""}`.trim();
  const value = raw.toLowerCase();
  if (
    value === "1" ||
    value === "true" ||
    value === "on" ||
    value === "prefer"
  ) {
    return "prefer";
  }
  if (value === "only" || value === "strict" || value === "required") {
    return "only";
  }
  if (raw) {
    return "off";
  }
  const clusterRole = `${process.env.COCALC_CLUSTER_ROLE ?? ""}`
    .trim()
    .toLowerCase();
  if (clusterRole === "seed" || clusterRole === "attached") {
    return "prefer";
  }
  return "off";
}

async function getProjectsFromProjection(opts: {
  account_id: string;
  limit: number;
  offset: number;
  hidden: boolean;
  search?: string;
  sort: AccountProjectIndexProjectListSort;
}): Promise<DBProject[]> {
  const rows = await listProjectedProjectsForAccount({
    account_id: opts.account_id,
    limit: opts.limit,
    offset: opts.offset,
    include_hidden: opts.hidden,
    search: opts.search,
    sort: opts.sort,
  });
  return rows.map((row) => ({
    project_id: row.project_id,
    title: row.title,
    description: row.description,
  }));
}

// I may add more fields and more options later...
export default async function getProjects({
  account_id,
  limit = 50,
  offset = 0,
  hidden = false,
  search,
  sort = "last_edited",
}: {
  account_id: string;
  limit?: number;
  offset?: number;
  hidden?: boolean;
  search?: string;
  sort?: AccountProjectIndexProjectListSort;
}): Promise<DBProject[]> {
  if (!isValidUUID(account_id)) {
    throw Error("account_id must be a UUIDv4");
  }
  if (limit <= 0) {
    return [];
  }
  if (offset < 0) {
    throw Error("offset must be nonnegative");
  }
  const readMode = getProjectListReadMode();
  if (readMode !== "off") {
    try {
      const projected = await getProjectsFromProjection({
        account_id,
        limit,
        offset,
        hidden,
        search,
        sort,
      });
      if (readMode === "only" || projected.length > 0) {
        return projected;
      }
    } catch (err) {
      if (readMode === "only") {
        throw err;
      }
    }
  }
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT project_id, title, description
       FROM projects
      WHERE deleted IS NOT TRUE
        AND users ? $1
        AND COALESCE(
          users #>> ARRAY[$1::TEXT, 'group']::TEXT[],
          ''
        ) IN ('owner', 'collaborator', 'viewer')
        AND ($3::BOOLEAN OR (users#>>'{${account_id},hide}')::BOOLEAN IS NOT TRUE)
        AND (
          $4::TEXT IS NULL OR
          title ILIKE $4::TEXT OR
          description ILIKE $4::TEXT OR
          state->>'state' ILIKE $4::TEXT
        )
      ORDER BY last_edited DESC
      LIMIT $2
      OFFSET $5`,
    [account_id, limit, hidden, search ? `%${search}%` : null, offset],
  );
  return rows;
}
