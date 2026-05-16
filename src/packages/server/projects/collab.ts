/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { PostgreSQL } from "@cocalc/database/postgres/types";
import { is_array, is_valid_uuid_string } from "@cocalc/util/misc";
import { callback2 } from "@cocalc/util/async-utils";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";

export async function add_collaborators_to_projects(
  db: PostgreSQL,
  account_id: string,
  accounts: string[],
  projects: string[],
): Promise<void> {
  try {
    await verify_write_access_to_projects(account_id, projects);
  } catch (err) {
    // There is one case where a user can add themself to a project that they
    // are not a collaborator on, which is a TA can add themself to a course project.
    // Technically this is the case when accounts[0] == account_id and
    // projects[0] points to a course in project_id where account_id is a
    // collaborator on project_id. We only support one accounts/projects.
    if (accounts.length == 1 && account_id == accounts[0]) {
      await verify_course_access_to_project(db, account_id, projects[0]);
    } else {
      throw err;
    }
  }

  /* Right now this function is called from outside typescript
    (e.g., api from user), so we have to do extra type checking.
    Also, the input is uuid's, which typescript can't check. */
  verify_types(account_id, accounts, projects);

  // We now know that account_id is allowed to add users to all of the projects.

  // Now we just need to do the actual collab add.  This could be done in many
  // ways that are more parallel, or via a single transaction, etc... but for
  // now let's just do it one at a time.   If any fail, then nothing further
  // will happen and the client gets an error.  This should result in minimal
  // load given that it's one at a time, and the server and db are a ms from
  // each other.
  for (const i in projects) {
    const project_id: string = projects[i];
    const account_id: string = accounts[i];
    if (await callback2(db.user_is_collaborator, { project_id, account_id })) {
      // Nothing to do since user is already on the given project.
      continue;
    }
    await callback2(db.add_user_to_project, {
      project_id,
      account_id,
    });
  }
  for (const project_id of new Set(projects)) {
    await syncProjectUsersOnHost({ project_id });
  }
}

export async function remove_collaborators_from_projects(
  db: PostgreSQL,
  account_id: string,
  accounts: string[],
  projects: string[],
): Promise<void> {
  try {
    // Ensure user is allowed to modify project(s)
    //
    await verify_write_access_to_projects(account_id, projects);
  } catch (err) {
    // Users can always remove themselves from a project.
    //
    if (accounts.length == 1 && account_id == accounts[0]) {
      await verify_course_access_to_project(db, account_id, projects[0]);
    } else {
      throw err;
    }
  }

  /* Right now this function is called from outside typescript
    (e.g., api from user), so we have to do extra type checking.
    Also, the input is uuid's, which typescript can't check. */
  verify_types(account_id, accounts, projects);

  // Remove users from projects
  //
  for (const i in projects) {
    const project_id: string = projects[i];
    const account_id: string = accounts[i];

    await callback2(db.remove_user_from_project, {
      project_id,
      account_id,
    });
  }
  for (const project_id of new Set(projects)) {
    await syncProjectUsersOnHost({ project_id });
  }
}

// This is only meant to be used here in support of
// add_collaborators_to_projects -- do not export it.
async function verify_write_access_to_projects(
  account_id: string,
  projects: string[],
): Promise<void> {
  // Also, we are not doing this in parallel, but could. Let's not
  // put undue load on the server for this.
  // Note that projects are likely to be repeated, so we use a Set.
  for (const project_id of new Set(projects)) {
    try {
      await assertLocalProjectCollaborator({ account_id, project_id });
    } catch (err) {
      throw Error(
        `user ${account_id} does not have write access to project ${project_id}: ${err}`,
      );
    }
  }
}

function verify_types(
  account_id: string,
  accounts: string[],
  projects: string[],
) {
  if (!is_valid_uuid_string(account_id))
    throw Error(
      `account_id (="${account_id}") must be a valid uuid string (type=${typeof account_id})`,
    );
  if (!is_array(accounts)) {
    throw Error("accounts must be an array");
  }
  if (!is_array(projects)) {
    throw Error("projects must be an array");
  }
  if (accounts.length != projects.length) {
    throw Error(
      `accounts (of length ${accounts.length}) and projects (of length ${projects.length}) must be arrays of the same length`,
    );
  }
  for (const x of accounts) {
    if (!is_valid_uuid_string(x))
      throw Error(`all account id's must be valid uuid's, but "${x}" is not`);
  }
  for (const x of projects) {
    if (x != "" && !is_valid_uuid_string(x))
      throw Error(
        `all project id's must be valid uuid's (or empty), but "${x}" is not`,
      );
  }
}

async function verify_course_access_to_project(
  db: PostgreSQL,
  account_id: string,
  project_id: string,
): Promise<void> {
  /*
  Raise an exception unless:

     - project_id is associated to a course in another project course_id
     - account_id is a collaborator on course_id.
   */
  // Get the course field of project_id
  const v = await db.async_query({
    query: "SELECT course FROM projects WHERE project_id=$1",
    params: [project_id],
  });
  if (v.rows.length == 0) {
    throw Error(`no project with id "${project_id}"`);
  }
  const course_id = v.rows[0].course?.project_id;
  if (!is_valid_uuid_string(course_id)) {
    throw Error(`cannot add self to "${project_id}" -- must be an admin`);
  }
  if (!is_valid_uuid_string(account_id)) {
    // be extra careful since we directly put account_id in the query string.
    throw Error(`account_id ${account_id} must be a valid uuid`);
  }
  try {
    await assertLocalProjectCollaborator({
      account_id,
      project_id: course_id,
    });
  } catch {
    throw Error(
      `cannot add self to "${project_id}" -- must be owner or collaborator on course project`,
    );
  }
}
