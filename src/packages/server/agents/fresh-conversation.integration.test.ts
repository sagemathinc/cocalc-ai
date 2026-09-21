import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import { startFreshConversationLocal } from "./api";
import { agentStore } from "./store";
import { PersonalAgentStore } from "./personal-store";

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
    agent_id = randomUUID(),
    peer_id = randomUUID(),
    network_id = randomUUID();
  beforeAll(async () => {
    const db = getPool();
    await db.query(
      "CREATE TABLE IF NOT EXISTS projects(project_id uuid PRIMARY KEY, users jsonb)",
    );
    await syncSchema(
      Object.fromEntries(
        [
          "agent_identities",
          "agent_identity_runs",
          "agent_personal_names",
          "agent_personal_controls",
          "agent_networks",
          "agent_network_members",
          "agent_external_identities",
          "agent_external_installations",
        ].map((name) => [name, SCHEMA[name]]),
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
    await db.query(
      `INSERT INTO agent_identities(agent_id,project_id,path,thread_id,name,created_by)
      VALUES($1,$2,'/home/user/peer.chat','peer','peer',$3)`,
      [peer_id, project_id, account_id],
    );
    for (const [id, name, path, thread] of [
      [agent_id, "helper", "/home/user/test.chat", "old"],
      [peer_id, "peer", "/home/user/peer.chat", "peer"],
    ]) {
      await db.query(
        `INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata)
        VALUES($1,$2,$3,$4,$5)`,
        [
          account_id,
          name,
          project_id,
          id,
          { path, thread_id: thread, description: "Persistent description" },
        ],
      );
    }
    await db.query(
      `INSERT INTO agent_networks(agent_network_id,account_id,title,generation,created_by,delivery_mode)
      VALUES($1,$2,'Persistent network',$3,$2,'live')`,
      [network_id, account_id, randomUUID()],
    );
    for (const id of [agent_id, peer_id]) {
      await db.query(
        `INSERT INTO agent_network_members(agent_network_id,member_kind,member_id,registered_agent_id,project_id,added_by)
        VALUES($1,'registered',$2,$2,$3,$4)`,
        [network_id, id, project_id, account_id],
      );
    }
  });
  afterAll(async () => {
    await getPool().end();
  });
  test("switch preserves identity and history and refuses old-thread credential issuance", async () => {
    const store = agentStore();
    const personal = new PersonalAgentStore(
      store,
      async (_account, endpoint) => store.get(endpoint.agent_id),
      async () => account_id,
      async () => {},
    );
    const source = { project_id, agent_id },
      peer = { project_id, agent_id: peer_id };
    const membershipsBefore = (
      await getPool().query(
        "SELECT * FROM agent_network_members WHERE agent_network_id=$1 ORDER BY member_id",
        [network_id],
      )
    ).rows;
    const old = await store.get(agent_id);
    const run = randomUUID();
    await store.issue(old, run, account_id);
    const authorizationBefore = await personal.checkNetwork(
      account_id,
      network_id,
      source,
      run,
      peer,
    );
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
    expect(
      await personal.checkNetwork(
        account_id,
        network_id,
        source,
        randomUUID(),
        peer,
      ),
    ).toEqual(authorizationBefore);
    expect(
      await personal.checkNetwork(
        account_id,
        network_id,
        peer,
        randomUUID(),
        source,
      ),
    ).toMatchObject({ target: { endpoint: source }, delivery_mode: "live" });
    expect(
      (
        await getPool().query(
          "SELECT * FROM agent_network_members WHERE agent_network_id=$1 ORDER BY member_id",
          [network_id],
        )
      ).rows,
    ).toEqual(membershipsBefore);
    const names = await personal.names(account_id);
    expect(names.find((agent) => agent.name === "helper")).toMatchObject({
      endpoint: source,
      path: old.path,
      thread_id: successor,
      description: "Persistent description",
      available: true,
    });
    expect(names).toHaveLength(2);
    const retry = await startFreshConversationLocal({
      account_id,
      project_id,
      agent_id,
      expected_thread_id: "old",
    });
    expect(retry.conversation_history).toHaveLength(1);
  });
});
