import getPool from "@cocalc/database/pool";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getProject } from "@cocalc/server/projects/control";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:projects:delete");

interface DeleteProjectOptions {
  project_id: string;
  account_id?: string;
  skipPermissionCheck?: boolean;
}

interface SetProjectDeletedOptions extends DeleteProjectOptions {
  deleted: boolean;
}

async function assertOwnerOrAdmin({
  project_id,
  account_id,
}: {
  project_id: string;
  account_id?: string;
}): Promise<void> {
  if (!account_id) {
    throw Error("must be signed in");
  }
  const admin = await userIsInGroup(account_id, "admin");
  let owner = false;
  if (!admin) {
    const pool = getPool();
    const { rows } = await pool.query<{ group: string | null }>(
      "SELECT users #>> ARRAY[$2::text, 'group'] AS \"group\" FROM projects WHERE project_id=$1",
      [project_id, account_id],
    );
    owner = rows[0]?.group === "owner";
  }
  if (!admin && !owner) {
    throw Error("must be an owner (or admin) to delete a project");
  }
}

export async function setProjectDeleted({
  project_id,
  account_id,
  deleted,
  skipPermissionCheck = false,
}: SetProjectDeletedOptions): Promise<void> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a valid uuid");
  }

  if (!skipPermissionCheck) {
    await assertOwnerOrAdmin({ project_id, account_id });
  }

  if (deleted) {
    const project = getProject(project_id);
    try {
      await project.stop();
    } catch (err) {
      log.debug("problem stopping project", { project_id, err });
    }
  }

  const pool = getPool();
  const result = await pool.query(
    "UPDATE projects SET deleted=$2 WHERE project_id=$1",
    [project_id, deleted],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw Error("project not found");
  }
}

export default async function deleteProject({
  project_id,
  account_id,
  skipPermissionCheck = false,
}: DeleteProjectOptions): Promise<void> {
  await setProjectDeleted({
    project_id,
    account_id,
    deleted: true,
    skipPermissionCheck,
  });
}
