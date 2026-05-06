import getPool from "@cocalc/database/pool";
import userIsInGroup from "@cocalc/server/accounts/is-in-group";
import { getProject } from "@cocalc/server/projects/control";
import { getLogger } from "@cocalc/backend/logger";
import { isValidUUID } from "@cocalc/util/misc";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import {
  releaseProjectBackupRepoAssignment,
  resolveProjectBackupRepoAssignment,
} from "@cocalc/server/project-backup";

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
  const client = await pool.connect();
  let backup_repo_id: string | null = null;
  let project_region: string | null = null;
  let assignmentAction:
    | { type: "release" }
    | {
        type: "restore";
        backup_repo_id: string;
        project_region?: string | null;
      }
    | null = null;
  try {
    await client.query("BEGIN");
    await assertProjectNotRehoming({
      db: client,
      project_id,
      action: deleted ? "delete project" : "undelete project",
    });
    const result = await client.query<{
      backup_repo_id: string | null;
      region: string | null;
    }>(
      "UPDATE projects SET deleted=$2 WHERE project_id=$1 RETURNING backup_repo_id, region",
      [project_id, deleted],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw Error("project not found");
    }
    backup_repo_id = result.rows[0]?.backup_repo_id ?? null;
    project_region = result.rows[0]?.region ?? null;
    if (deleted) {
      assignmentAction = { type: "release" };
      await releaseProjectBackupRepoAssignment({ project_id });
    } else if (backup_repo_id) {
      assignmentAction = {
        type: "restore",
        backup_repo_id,
        project_region,
      };
      await resolveProjectBackupRepoAssignment({
        project_id,
        project_region,
        backup_repo_id,
      });
    }
    await appendProjectOutboxEventForProject({
      db: client,
      event_type: deleted ? "project.deleted" : "project.summary_changed",
      project_id,
      default_bay_id: getConfiguredBayId(),
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (assignmentAction?.type === "release" && backup_repo_id) {
      try {
        await resolveProjectBackupRepoAssignment({
          project_id,
          project_region,
          backup_repo_id,
        });
      } catch (restoreErr) {
        log.warn("failed to restore backup shard assignment after rollback", {
          project_id,
          err: `${restoreErr}`,
        });
      }
    } else if (assignmentAction?.type === "restore") {
      try {
        await releaseProjectBackupRepoAssignment({ project_id });
      } catch (releaseErr) {
        log.warn("failed to release backup shard assignment after rollback", {
          project_id,
          err: `${releaseErr}`,
        });
      }
    }
    throw err;
  } finally {
    client.release();
  }
  await publishProjectAccountFeedEventsBestEffort({
    project_id,
    default_bay_id: getConfiguredBayId(),
  });
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
