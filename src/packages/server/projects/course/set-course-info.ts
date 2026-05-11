/*
Set the course info about a student project.

This is the course field in the projects table.

For security reasons, this function does a lot more than
just set the course field as requested:

- If the account_id requesting the change is not a collaborator on
course.project_id, for the current value of the course field, then
the request is rejected.   This is because the teacher and TA's
are the collaborators on course.project_id, and only they should
be able to change the course field.

Course payment is membership-tier based; this endpoint only persists the course
metadata and does not compute or preserve legacy quota-derived payment fields.
*/

import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import getPool, { PoolClient } from "@cocalc/database/pool";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";
import type { CourseInfo } from "@cocalc/util/db-schema/projects";

interface Options {
  account_id: string; // who is setting the course field
  project_id: string; // the project id of the student project
  course: CourseInfo; // what it is being set to
  noCheck?: boolean; // if set to true, don't check permissions for account_id.  This is for internal use and not accessible via the api.
  client?: PoolClient;
}
export default async function setCourseInfo({
  account_id,
  project_id,
  course,
  noCheck,
  client,
}: Options): Promise<{ course: CourseInfo }> {
  if (!noCheck) {
    await assertLocalProjectCollaborator({ account_id, project_id });
  }
  if (typeof course != "object") {
    // just in case
    throw Error("course must be an object of type CourseInfo");
  }
  const pool = client ?? getPool();

  // get current value of course:
  const { rows } = await pool.query(
    "SELECT course FROM projects WHERE project_id=$1",
    [project_id],
  );
  if (rows.length == 0) {
    // shouldn't happen due to isCollaborator check above
    throw Error("no such project");
  }
  const currentCourse: CourseInfo | undefined = rows[0].course;
  if (!noCheck && currentCourse?.project_id != null) {
    // check that account_id is a collab, so allowed to edit course field.
    await assertLocalProjectCollaborator({
      account_id,
      project_id: currentCourse.project_id,
    });
  }

  await pool.query("UPDATE projects SET course=$1 WHERE project_id=$2", [
    course,
    project_id,
  ]);
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["course"],
  });
  return { course };
}
