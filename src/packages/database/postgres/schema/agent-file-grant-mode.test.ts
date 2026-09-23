import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import { ensureAgentFileGrantModeSchema } from "./agent-file-grant-mode";

beforeAll(async () => {
  await initEphemeralDatabase({});
}, 30_000);
afterAll(async () => {
  await testCleanup();
});

test("upgrades a legacy read-only constraint idempotently without widening existing grants", async () => {
  const client = await getPool().connect();
  try {
    await client.query(
      "CREATE TEMP TABLE agent_file_grants (mode text NOT NULL CONSTRAINT agent_file_grants_mode_check CHECK(mode IN ('read')))",
    );
    await client.query("INSERT INTO agent_file_grants VALUES ('read')");
    await expect(
      client.query("INSERT INTO agent_file_grants VALUES ('read-write')"),
    ).rejects.toThrow();
    await ensureAgentFileGrantModeSchema(client);
    await ensureAgentFileGrantModeSchema(client);
    expect(
      (await client.query("SELECT mode FROM agent_file_grants")).rows,
    ).toEqual([{ mode: "read" }]);
    await client.query("INSERT INTO agent_file_grants VALUES ('read-write')");
    await expect(
      client.query("INSERT INTO agent_file_grants VALUES ('admin')"),
    ).rejects.toThrow();
    await expect(
      client.query("INSERT INTO agent_file_grants VALUES (NULL)"),
    ).rejects.toThrow();
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.agent_file_grants");
    client.release();
  }
});
