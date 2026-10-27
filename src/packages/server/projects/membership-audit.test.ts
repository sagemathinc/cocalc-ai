/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// End to end, against the database: the membership audit trigger
// (database/postgres/schema/project-membership-audit.ts) records grants made
// by the code paths below, attributed to who made them.

import { after, before, getPool } from "@cocalc/server/test";
import { uuid } from "@cocalc/util/misc";

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  syncProjectUsersOnHost: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));

beforeAll(async () => {
  await before({ noConat: true });
}, 15_000);

afterAll(after);

async function addedRows(project_id: string) {
  const { rows } = await getPool().query(
    `SELECT value FROM central_log
      WHERE event='project_collaborator_added' AND value->>'project_id'=$1
      ORDER BY time`,
    [project_id],
  );
  return rows.map((row) => row.value);
}

async function project(users: object, course?: object) {
  const project_id = uuid();
  await getPool().query(
    "INSERT INTO projects(project_id,users,course) VALUES($1,$2::jsonb,$3::jsonb)",
    [project_id, JSON.stringify(users), course ? JSON.stringify(course) : null],
  );
  return project_id;
}

describe("project membership audit, end to end", () => {
  it("records course managers added to student projects, attributed to the manager", async () => {
    const owner = uuid();
    const manager = uuid();
    const course_project_id = uuid();
    const project_id = await project(
      { [owner]: { group: "owner" } },
      { type: "student", project_id: course_project_id },
    );
    const { ensureCourseManagerAccessLocal } =
      await import("./course/ensure-manager-access");
    await expect(
      ensureCourseManagerAccessLocal({
        account_id: owner,
        course_project_id,
        project_ids: [project_id],
        manager_account_ids: [manager],
        trustedCourseAccess: true,
      }),
    ).resolves.toEqual([{ project_id, added_account_ids: [manager] }]);
    expect(await addedRows(project_id)).toEqual([
      expect.objectContaining({
        via: "course-manager-access",
        actor_account_id: owner,
        added_account_ids: [manager],
        groups: { [manager]: "collaborator" },
      }),
    ]);
  });

  it("records a legacy project import, attributed to the importing user", async () => {
    const owner = uuid();
    const importer = uuid();
    const project_id = await project({ [owner]: { group: "owner" } });
    const { __test__ } = await import("../legacy-migration");
    await __test__.addMigrationCollaborator({
      account_id: importer,
      project_id,
    });
    expect(await addedRows(project_id)).toEqual([
      expect.objectContaining({
        via: "legacy-import",
        actor_account_id: importer,
        added_account_ids: [importer],
      }),
    ]);
  });

  it("records the database helper's adds with the caller's context", async () => {
    const owner = uuid();
    const member = uuid();
    const project_id = await project({ [owner]: { group: "owner" } });
    const { db } = await import("@cocalc/database");
    const { callback2 } = await import("@cocalc/util/async-utils");
    const database = db();
    await callback2(database.add_user_to_project.bind(database), {
      project_id,
      account_id: member,
      group: "viewer",
      audit: { actor_account_id: owner, via: "admin-add" },
    });
    expect(await addedRows(project_id)).toEqual([
      expect.objectContaining({
        via: "admin-add",
        actor_account_id: owner,
        added_account_ids: [member],
        groups: { [member]: "viewer" },
      }),
    ]);
  });
});
