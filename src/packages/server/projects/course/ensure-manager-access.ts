/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { appendProjectOutboxEventForProject } from "@cocalc/database/postgres/project-events-outbox";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import type { CourseManagerAccessResult } from "@cocalc/conat/hub/api/projects";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { publishProjectAccountFeedEventsBestEffort } from "@cocalc/server/account/project-feed";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("projects:course:ensure-manager-access");
const COURSE_PROJECT_TYPES = new Set(["student", "shared", "nbgrader"]);
const MAX_PROJECTS = 1000;

interface EnsureCourseManagerAccessLocalOptions {
  account_id?: string;
  course_project_id: string;
  course_path?: string;
  project_ids: string[];
  manager_account_ids?: string[];
  trustedCourseAccess?: boolean;
}

interface ProjectRow {
  project_id: string;
  users: Record<string, { group?: string }> | null;
  course: {
    project_id?: string;
    path?: string;
    type?: string;
  } | null;
}

function uniqueValidUuids(ids: string[], name: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    const value = `${id ?? ""}`.trim();
    if (!value) {
      continue;
    }
    if (!isValidUUID(value)) {
      throw new Error(`invalid ${name}: ${value}`);
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

async function getCourseManagerAccountIds(
  course_project_id: string,
): Promise<string[]> {
  const { rows } = await getPool().query<{ users: ProjectRow["users"] }>(
    "SELECT users FROM projects WHERE project_id=$1 LIMIT 1",
    [course_project_id],
  );
  const users = rows[0]?.users;
  if (!users) {
    throw new Error(`course project ${course_project_id} not found`);
  }
  return Object.entries(users)
    .filter(
      ([, user]) => user?.group === "owner" || user?.group === "collaborator",
    )
    .map(([account_id]) => account_id)
    .filter((account_id) => isValidUUID(account_id));
}

function validateCourseLink({
  course,
  course_project_id,
}: {
  course: ProjectRow["course"];
  course_project_id: string;
}): string | undefined {
  if (course == null || typeof course !== "object") {
    return "project is not marked as belonging to a course";
  }
  if (course.project_id !== course_project_id) {
    return "project belongs to a different course project";
  }
  if (course.type != null && !COURSE_PROJECT_TYPES.has(`${course.type}`)) {
    return "project is not a managed course project";
  }
  return;
}

async function addManagersToProject({
  client,
  project_id,
  manager_account_ids,
}: {
  client: PoolClient;
  project_id: string;
  manager_account_ids: string[];
}): Promise<void> {
  const additions = Object.fromEntries(
    manager_account_ids.map((account_id) => [
      account_id,
      { group: "collaborator" },
    ]),
  );
  await assertProjectNotRehoming({
    db: client,
    project_id,
    action: "add course managers to project",
  });
  await client.query(
    `UPDATE projects
        SET users = COALESCE(users, '{}'::jsonb) || $2::jsonb
      WHERE project_id=$1`,
    [project_id, JSON.stringify(additions)],
  );
  await appendProjectOutboxEventForProject({
    db: client,
    event_type: "project.membership_changed",
    project_id,
  });
}

async function syncProjectUsersBestEffort(project_id: string): Promise<void> {
  try {
    await syncProjectUsersOnHost({ project_id });
  } catch (err) {
    logger.warn("unable to sync project users after course manager repair", {
      project_id,
      err,
    });
  }
}

export async function ensureCourseManagerAccessLocal({
  account_id,
  course_project_id,
  project_ids,
  manager_account_ids,
  trustedCourseAccess,
}: EnsureCourseManagerAccessLocalOptions): Promise<
  CourseManagerAccessResult[]
> {
  if (!isValidUUID(course_project_id)) {
    throw new Error("invalid course_project_id");
  }
  if (!trustedCourseAccess) {
    if (!account_id) {
      throw new Error("user must be signed in");
    }
    await assertLocalProjectCollaborator({
      account_id,
      project_id: course_project_id,
    });
  }

  const projectIds = uniqueValidUuids(project_ids, "project_id");
  if (projectIds.length > MAX_PROJECTS) {
    throw new Error(`too many projects; maximum is ${MAX_PROJECTS}`);
  }
  if (projectIds.length === 0) {
    return [];
  }
  const managerAccountIds = uniqueValidUuids(
    manager_account_ids ??
      (await getCourseManagerAccountIds(course_project_id)),
    "manager_account_id",
  );
  if (managerAccountIds.length === 0) {
    return projectIds.map((project_id) => ({
      project_id,
      added_account_ids: [],
    }));
  }

  const { rows } = await getPool().query<ProjectRow>(
    `SELECT project_id::text, users, course
       FROM projects
      WHERE project_id = ANY($1::uuid[])`,
    [projectIds],
  );
  const rowByProjectId = new Map(rows.map((row) => [row.project_id, row]));
  const results: CourseManagerAccessResult[] = [];

  for (const project_id of projectIds) {
    const row = rowByProjectId.get(project_id);
    if (!row) {
      results.push({
        project_id,
        added_account_ids: [],
        error: "project not found",
      });
      continue;
    }
    const error = validateCourseLink({
      course: row.course,
      course_project_id,
    });
    if (error) {
      results.push({ project_id, added_account_ids: [], error });
      continue;
    }

    const users = row.users ?? {};
    const toAdd = managerAccountIds.filter((account_id) => {
      const group = users[account_id]?.group;
      return group !== "owner" && group !== "collaborator";
    });
    if (toAdd.length === 0) {
      results.push({ project_id, added_account_ids: [] });
      continue;
    }

    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await addManagersToProject({
        client,
        project_id,
        manager_account_ids: toAdd,
      });
      await client.query("COMMIT");
      await publishProjectAccountFeedEventsBestEffort({ project_id });
      await syncProjectUsersBestEffort(project_id);
      results.push({ project_id, added_account_ids: toAdd });
    } catch (err) {
      await client.query("ROLLBACK");
      results.push({
        project_id,
        added_account_ids: [],
        error: `${err}`,
      });
    } finally {
      client.release();
    }
  }
  return results;
}
