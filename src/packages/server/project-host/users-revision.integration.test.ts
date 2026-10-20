/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Every collaborator list a host gets carries its revision, read in the same
// query: runtime_authority_revision, which the projects trigger raises with
// every change of users. The host keeps only the newest (project-host
// sqlite/projects.ts), so a list loaded before a change and delivered after
// it can't bring the old collaborators back. Run with COCALC_TEST_USE_PGLITE=1.

import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";

const pushes: any[] = [];
jest.mock("@cocalc/server/project-host/client", () => ({
  getRoutedHostControlClient: async () => ({
    updateProjectUsers: async (update) => {
      pushes.push(update);
    },
  }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("collaborator lists sent to hosts carry their revision", () => {
  const project_id = randomUUID();
  const host_id = randomUUID();
  const owner = randomUUID();
  const other = randomUUID();

  beforeAll(async () => {
    await syncSchema({
      projects: SCHEMA.projects,
      accounts: SCHEMA.accounts,
      project_hosts: SCHEMA.project_hosts,
    });
    await getPool().query(
      `INSERT INTO projects (project_id, users, host_id, rootfs_image)
       VALUES ($1, $2, $3, 'ubuntu')`,
      [project_id, { [owner]: { group: "owner" } }, host_id],
    );
  });

  it("each change raises the revision the host is sent", async () => {
    const { syncProjectUsersOnHost } = await import("./control");
    await syncProjectUsersOnHost({ project_id, expected_host_id: host_id });
    const first = pushes.at(-1);
    expect(first.users).toEqual({ [owner]: { group: "owner" } });
    expect(typeof first.users_revision).toBe("number");

    await getPool().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project_id,
      { [owner]: { group: "owner" }, [other]: { group: "collaborator" } },
    ]);
    await syncProjectUsersOnHost({ project_id, expected_host_id: host_id });
    const second = pushes.at(-1);
    expect(Object.keys(second.users).sort()).toEqual([owner, other].sort());
    expect(second.users_revision).toBeGreaterThan(first.users_revision);

    // Writing the same list again is not a change.
    await getPool().query("UPDATE projects SET users=$2 WHERE project_id=$1", [
      project_id,
      second.users,
    ]);
    await syncProjectUsersOnHost({ project_id, expected_host_id: host_id });
    expect(pushes.at(-1).users_revision).toBe(second.users_revision);
  });
});
