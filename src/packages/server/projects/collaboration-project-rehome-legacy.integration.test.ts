/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { PROJECT_COLLABORATION_REHOME_TABLES } from "@cocalc/util/project-collaboration-rehome";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import {
  ensureProjectCollaborationRehomeSchema,
  freezeProjectCollaborationExport,
  readProjectCollaborationExportPage,
} from "./collaboration-project-rehome";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const source = "legacy-owner-source";
const originalBay = process.env.COCALC_BAY_ID;

describeDb("legacy project ownership during collaboration rehome", () => {
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = source;
    await initEphemeralDatabase();
    await getPool().query(`CREATE TABLE project_rehome_operations (
      op_id UUID PRIMARY KEY,project_id UUID,source_bay_id TEXT,dest_bay_id TEXT,status TEXT)`);
    await ensureProjectCollaborationRehomeSchema();
  }, 60_000);
  afterAll(async () => {
    if (originalBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = originalBay;
    await getPool().end();
  });
  async function fixture(owner: string | null | undefined) {
    const op = {
      op_id: randomUUID(),
      project_id: randomUUID(),
      source_bay_id: source,
      dest_bay_id: "legacy-owner-destination",
    };
    if (owner !== undefined)
      await getPool().query(
        "INSERT INTO projects(project_id,owning_bay_id) VALUES($1,$2)",
        [op.project_id, owner],
      );
    await getPool().query(
      "INSERT INTO project_rehome_operations VALUES($1,$2,$3,$4,'running')",
      [op.op_id, op.project_id, op.source_bay_id, op.dest_bay_id],
    );
    return op;
  }
  test("NULL ownership without collaboration state preserves the legacy path", async () => {
    const op = await fixture(null);
    expect(await freezeProjectCollaborationExport(op)).toBeUndefined();
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM project_collaboration_rehome_transfers WHERE op_id=$1",
          [op.op_id],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await getPool().query(
          "SELECT owning_bay_id FROM projects WHERE project_id=$1",
          [op.project_id],
        )
      ).rows[0].owning_bay_id,
    ).toBeNull();
  });
  test("NULL ownership remains authoritative throughout every bounded export page", async () => {
    const op = await fixture(null);
    const generation = randomUUID();
    await getPool().query(
      "INSERT INTO collaboration_projects(project_id,generation) VALUES($1,$2)",
      [op.project_id, generation],
    );
    const header = await freezeProjectCollaborationExport(op);
    expect(header).toBeDefined();
    const page = await readProjectCollaborationExportPage(header!, "0");
    expect(page.rows[0]).toMatchObject({
      project_id: op.project_id,
      generation,
    });
    expect(
      (
        await getPool().query(
          "SELECT state,next_page FROM project_collaboration_rehome_transfers WHERE op_id=$1",
          [op.op_id],
        )
      ).rows[0],
    ).toEqual({
      state: "exported",
      next_page: PROJECT_COLLABORATION_REHOME_TABLES.length,
    });
    expect(await freezeProjectCollaborationExport(op)).toEqual(header);
  });
  test.each([undefined, "another-owner"])(
    "missing or foreign-owned project (%s) cannot export",
    async (owner) => {
      const op = await fixture(owner);
      await expect(freezeProjectCollaborationExport(op)).rejects.toThrow(
        "not authoritative",
      );
      expect(
        (
          await getPool().query(
            "SELECT 1 FROM project_collaboration_rehome_transfers WHERE op_id=$1",
            [op.op_id],
          )
        ).rows,
      ).toEqual([]);
    },
  );
});
