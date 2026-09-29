import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { syncCollaborationRevisionOutboxSchema } from "./collaborators-revision-outbox";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" &&
  process.env.COCALC_DB === "pglite" &&
  process.env.COCALC_PGLITE_DATA_DIR === "memory://"
    ? describe
    : describe.skip;

describeDb("atomic owner catalog revision intent", () => {
  beforeAll(async () => {
    await initEphemeralDatabase();
    await syncCollaborationRevisionOutboxSchema(getPool());
    await syncCollaborationRevisionOutboxSchema(getPool());
  }, 60000);
  afterAll(async () => {
    await getPool().end();
  });
  async function fixture() {
    const id = randomUUID();
    await getPool().query("INSERT INTO projects(project_id) VALUES($1)", [id]);
    await getPool().query(
      "INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,1)",
      [id, randomUUID()],
    );
    return id;
  }
  const read = async (id: string) =>
    (
      await getPool().query(
        "SELECT token,generation,revision::text,due_at,after_home_bay FROM collaboration_revision_outbox WHERE project_id=$1",
        [id],
      )
    ).rows;

  test("coalesces actual changes and preserves no-op tokens", async () => {
    const id = await fixture();
    const [first] = await read(id);
    await getPool().query(
      "UPDATE collaboration_projects SET revision=revision WHERE project_id=$1",
      [id],
    );
    expect(await read(id)).toEqual([first]);
    await getPool().query(
      "UPDATE collaboration_revision_outbox SET after_home_bay='home-z' WHERE project_id=$1",
      [id],
    );
    for (let i = 0; i < 3; i++)
      await getPool().query(
        "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1",
        [id],
      );
    const [latest] = await read(id);
    expect(latest).toMatchObject({
      generation: first.generation,
      revision: "4",
      after_home_bay: null,
      due_at: first.due_at,
    });
    expect(latest.token).not.toBe(first.token);
    expect(await read(id)).toHaveLength(1);
    const generation = randomUUID();
    await getPool().query(
      "UPDATE collaboration_projects SET generation=$2,revision=0 WHERE project_id=$1",
      [id, generation],
    );
    const [reset] = await read(id);
    expect(reset).toMatchObject({ generation, revision: "0" });
    expect(reset.token).not.toBe(latest.token);
  });
  test("rollback cannot publish uncommitted invalidation", async () => {
    const id = await fixture();
    const before = await read(id);
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await db.query(
        "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1",
        [id],
      );
      await db.query("ROLLBACK");
    } finally {
      db.release();
    }
    expect(await read(id)).toEqual(before);
    expect(
      (
        await getPool().query(
          "SELECT revision::text FROM collaboration_projects WHERE project_id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ revision: "1" }]);
  });
  test("project deletion removes pending intent", async () => {
    const id = await fixture();
    await getPool().query("DELETE FROM projects WHERE project_id=$1", [id]);
    expect(await read(id)).toEqual([]);
  });
});
