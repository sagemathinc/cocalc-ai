/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { readCollaborationAccess } from "./collaborators-access";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;
const bay = "access-fence-test";

describeDb("collaboration access respects durable project handoffs", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
  }, 60_000);
  afterAll(async () => {
    await getPool().end();
  });
  beforeEach(async () => {
    // These auxiliary tables are not in the ordinary schema. Each test gets its
    // own projects; only this process's private memory DB has tables dropped.
    await getPool().query(
      "DROP TABLE IF EXISTS project_rehome_operations,project_collaboration_rehome_transfers",
    );
  });
  async function fixture(owner = bay) {
    const request = { project_id: randomUUID(), account_id: randomUUID() };
    await getPool().query(
      "INSERT INTO projects(project_id,owning_bay_id,users) VALUES($1,$2,$3::jsonb)",
      [
        request.project_id,
        owner,
        JSON.stringify({ [request.account_id]: { group: "collaborator" } }),
      ],
    );
    return request;
  }
  async function installTransfers() {
    await getPool().query(
      "CREATE TABLE project_collaboration_rehome_transfers(project_id UUID,direction TEXT,state TEXT)",
    );
  }
  async function expectNoInitialization(project_id: string) {
    expect(
      (
        await getPool().query(
          "SELECT 1 FROM collaboration_projects WHERE project_id=$1",
          [project_id],
        )
      ).rows,
    ).toEqual([]);
  }
  test("legacy database without either rehome table still grants access", async () => {
    const request = await fixture();
    expect(await readCollaborationAccess([request], bay)).toEqual([
      { ...request, generation: expect.any(String) },
    ]);
  });
  test.each([
    ["export", "exporting"],
    ["export", "exported"],
    ["import", "staging"],
    ["import", "ready"],
  ])(
    "%s/%s denies access and initialization without blocking unrelated projects",
    async (direction, state) => {
      await installTransfers();
      const frozen = await fixture(),
        available = await fixture();
      await getPool().query(
        "INSERT INTO project_collaboration_rehome_transfers VALUES($1,$2,$3)",
        [frozen.project_id, direction, state],
      );
      const result = await readCollaborationAccess([frozen, available], bay);
      expect(result).toContainEqual({ ...frozen, generation: null });
      expect(result).toContainEqual({
        ...available,
        generation: expect.any(String),
      });
      await expectNoInitialization(frozen.project_id);
      // The same fence denies fresh grants even if metadata predates the freeze.
      await getPool().query(
        "INSERT INTO collaboration_projects(project_id,generation) VALUES($1,$2)",
        [frozen.project_id, randomUUID()],
      );
      expect(await readCollaborationAccess([frozen], bay)).toEqual([
        { ...frozen, generation: null },
      ]);
    },
  );
  test("failed legacy operation cannot bypass the export's durable fence", async () => {
    const request = await fixture();
    await installTransfers();
    await getPool().query(
      "CREATE TABLE project_rehome_operations(project_id UUID,status TEXT)",
    );
    await getPool().query(
      "INSERT INTO project_rehome_operations VALUES($1,'failed')",
      [request.project_id],
    );
    await getPool().query(
      "INSERT INTO project_collaboration_rehome_transfers VALUES($1,'export','exported')",
      [request.project_id],
    );
    expect(await readCollaborationAccess([request], bay)).toEqual([
      { ...request, generation: null },
    ]);
    await expectNoInitialization(request.project_id);
  });
  test.each([
    ["export", "retired"],
    ["import", "activated"],
  ])(
    "%s/%s does not permanently freeze a current owner or grant a stale owner",
    async (direction, state) => {
      await installTransfers();
      const current = await fixture(),
        moved = await fixture("new-owner");
      await getPool().query(
        "INSERT INTO project_collaboration_rehome_transfers VALUES($1,$3,$4),($2,$3,$4)",
        [current.project_id, moved.project_id, direction, state],
      );
      const result = await readCollaborationAccess([current, moved], bay);
      expect(result).toContainEqual({
        ...current,
        generation: expect.any(String),
      });
      expect(result).toContainEqual({ ...moved, generation: null });
      await expectNoInitialization(moved.project_id);
    },
  );
  test("running legacy operation remains fenced without a transfer table", async () => {
    const request = await fixture();
    await getPool().query(
      "CREATE TABLE project_rehome_operations(project_id UUID,status TEXT)",
    );
    await getPool().query(
      "INSERT INTO project_rehome_operations VALUES($1,'running')",
      [request.project_id],
    );
    expect(await readCollaborationAccess([request], bay)).toEqual([
      { ...request, generation: null },
    ]);
    await expectNoInitialization(request.project_id);
  });
});
