/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import { projectRuntimeAuthorityRevisionSchemaNeedsSync } from "./project-runtime-authority-revision";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 15_000);

afterAll(async () => {
  await testCleanup();
});

describe("project runtime authority revision", () => {
  it("advances for each distinct collaborator-map change, including ABA", async () => {
    const pool = getPool();
    const projectId = uuid();
    const ownerId = uuid();
    const collaboratorId = uuid();
    const originalUsers = {
      [ownerId]: { group: "owner" },
    };
    await pool.query(
      "INSERT INTO projects (project_id, users) VALUES ($1, $2::jsonb)",
      [projectId, JSON.stringify(originalUsers)],
    );

    const revision = async (): Promise<string> =>
      await pool
        .query<{ runtime_authority_revision: string }>(
          `SELECT runtime_authority_revision::text
             FROM projects
            WHERE project_id=$1`,
          [projectId],
        )
        .then(({ rows }) => rows[0].runtime_authority_revision);

    expect(await revision()).toBe("0");
    await pool.query(
      "UPDATE projects SET title='unrelated' WHERE project_id=$1",
      [projectId],
    );
    expect(await revision()).toBe("0");

    const withCollaborator = {
      ...originalUsers,
      [collaboratorId]: { group: "collaborator" },
    };
    await pool.query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [projectId, JSON.stringify(withCollaborator)],
    );
    expect(await revision()).toBe("1");

    await pool.query(
      "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
      [projectId, JSON.stringify(originalUsers)],
    );
    expect(await revision()).toBe("2");

    const client = await pool.connect();
    try {
      await expect(
        projectRuntimeAuthorityRevisionSchemaNeedsSync(client),
      ).resolves.toBe(false);
    } finally {
      client.release();
    }
    await pool.query("DELETE FROM projects WHERE project_id=$1", [projectId]);
  });
});
