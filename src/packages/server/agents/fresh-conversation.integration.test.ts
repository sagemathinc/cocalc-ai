import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { startFreshConversationLocal } from "./api";
import { agentStore } from "./store";

jest.mock("./access", () => ({
  assertActor: async () => {},
  assertLocalAgentProject: async () => {},
}));
jest.mock("@cocalc/server/conat/route-client", () => ({
  conatWithProjectRoutingForAccount: () => ({}),
}));
const successor = randomUUID();
jest.mock("@cocalc/conat/ai/acp/client", () => ({
  controlAcp: async () => ({ ok: true, successor_thread_id: successor }),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("fresh conversation identity persistence", () => {
  const account_id = randomUUID(),
    project_id = randomUUID(),
    agent_id = randomUUID();
  beforeAll(async () => {
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema(
      Object.fromEntries(
        ["agent_identities", "agent_identity_runs"].map((name) => [
          name,
          SCHEMA[name],
        ]),
      ),
    );
    await db.query("INSERT INTO projects(project_id,users) VALUES($1,'{}')", [
      project_id,
    ]);
    await db.query(
      `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
      VALUES($1,$2,'/home/user/test.chat','old','helper',$3)`,
      [agent_id, project_id, account_id],
    );
  });
  afterAll(async () => {
    await getPool().end();
  });
  test("switch preserves identity and history and refuses old-thread credential issuance", async () => {
    const store = agentStore();
    const old = await store.get(agent_id);
    const run = randomUUID();
    await store.issue(old, run, account_id);
    const next = await startFreshConversationLocal({
      account_id,
      project_id,
      agent_id,
      expected_thread_id: "old",
    });
    expect(next.agent_id).toBe(agent_id);
    expect(next.path).toBe(old.path);
    expect(next.thread_id).toBe(successor);
    expect(next.conversation_history?.map((entry) => entry.thread_id)).toEqual([
      "old",
    ]);
    const ended = (
      await getPool().query(
        "SELECT ended_at FROM agent_identity_runs WHERE agent_id=$1 AND run_id=$2",
        [agent_id, run],
      )
    ).rows[0];
    expect(ended.ended_at).toBeTruthy();
    await expect(store.issue(old, randomUUID(), account_id)).rejects.toThrow(
      "conversation changed",
    );
    await expect(
      store.issue(next, randomUUID(), account_id),
    ).resolves.toBeTruthy();
    const retry = await startFreshConversationLocal({
      account_id,
      project_id,
      agent_id,
      expected_thread_id: "old",
    });
    expect(retry.conversation_history).toHaveLength(1);
  });
});
