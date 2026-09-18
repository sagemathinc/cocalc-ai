/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import type { Client } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { uuid } from "@cocalc/util/misc";
import {
  ensureProjectRuntimeAuthorityRevisionSchema,
  PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER,
  projectRuntimeAuthorityRevisionSchemaNeedsSync,
} from "./project-runtime-authority-revision";

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

  it("rolls back function installation when trigger creation fails", async () => {
    const pool = getPool();
    const projectId = uuid();
    await pool.query(
      "INSERT INTO projects (project_id, users) VALUES ($1, $2::jsonb)",
      [projectId, JSON.stringify({ [uuid()]: { group: "owner" } })],
    );
    await pool.query(
      "DROP FUNCTION projects_bump_runtime_authority_revision() CASCADE",
    );
    const before = await pool
      .query<{ revision: string }>(
        `SELECT runtime_authority_revision::text AS revision
           FROM projects WHERE project_id=$1`,
        [projectId],
      )
      .then(({ rows }) => rows[0].revision);

    const client = await pool.connect();
    const failingClient = {
      query: async (...args: any[]) => {
        if (`${args[0]}`.trim().startsWith("CREATE TRIGGER")) {
          throw new Error("injected trigger creation failure");
        }
        return await (client.query as any).apply(client, args);
      },
    } as Client;
    try {
      await expect(
        ensureProjectRuntimeAuthorityRevisionSchema(failingClient),
      ).rejects.toThrow("injected trigger creation failure");
    } finally {
      client.release();
    }

    await expect(
      pool
        .query<{ revision: string }>(
          `SELECT runtime_authority_revision::text AS revision
             FROM projects WHERE project_id=$1`,
          [projectId],
        )
        .then(({ rows }) => rows[0].revision),
    ).resolves.toBe(before);
    await expect(
      pool
        .query<{ function_exists: boolean }>(
          `SELECT to_regprocedure(
             'projects_bump_runtime_authority_revision()'
           ) IS NOT NULL AS function_exists`,
        )
        .then(({ rows }) => rows[0].function_exists),
    ).resolves.toBe(false);
    const repairClient = await pool.connect();
    try {
      await expect(
        projectRuntimeAuthorityRevisionSchemaNeedsSync(repairClient),
      ).resolves.toBe(true);
      await ensureProjectRuntimeAuthorityRevisionSchema(repairClient);
    } finally {
      repairClient.release();
    }
    await pool.query("DELETE FROM projects WHERE project_id=$1", [projectId]);
  });

  const realPostgresIt = process.env.COCALC_TEST_USE_PGLITE ? it.skip : it;
  realPostgresIt(
    "serializes first installation with a concurrent collaborator update",
    async () => {
      const pool = getPool();
      const projectId = uuid();
      const ownerId = uuid();
      const collaboratorId = uuid();
      await pool.query(
        "INSERT INTO projects (project_id, users) VALUES ($1, $2::jsonb)",
        [projectId, JSON.stringify({ [ownerId]: { group: "owner" } })],
      );
      await pool.query(
        `DROP TRIGGER ${PROJECT_RUNTIME_AUTHORITY_REVISION_TRIGGER} ON projects`,
      );

      const installer = await pool.connect();
      const writer = await pool.connect();
      const writerPid = await writer
        .query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        .then(({ rows }) => rows[0].pid);
      let writerPromise: Promise<unknown> | undefined;
      const installingClient = {
        query: async (...args: any[]) => {
          const result = await (installer.query as any).apply(installer, args);
          if (`${args[0]}`.trim().startsWith("LOCK TABLE")) {
            writerPromise = writer.query(
              "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
              [
                projectId,
                JSON.stringify({
                  [ownerId]: { group: "owner" },
                  [collaboratorId]: { group: "collaborator" },
                }),
              ],
            );
            let blocked = false;
            for (let i = 0; i < 100 && !blocked; i += 1) {
              blocked = await installer
                .query<{
                  blocked: boolean;
                }>("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [
                  writerPid,
                ])
                .then(({ rows }) => rows[0].blocked);
              if (!blocked) {
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            }
            expect(blocked).toBe(true);
          }
          return result;
        },
      } as Client;

      try {
        await ensureProjectRuntimeAuthorityRevisionSchema(installingClient);
        await writerPromise;
      } finally {
        installer.release();
        writer.release();
      }

      await expect(
        pool
          .query<{ revision: string }>(
            `SELECT runtime_authority_revision::text AS revision
               FROM projects WHERE project_id=$1`,
            [projectId],
          )
          .then(({ rows }) => rows[0].revision),
      ).resolves.toBe("1");
      await pool.query("DELETE FROM projects WHERE project_id=$1", [projectId]);
    },
    15_000,
  );
});
