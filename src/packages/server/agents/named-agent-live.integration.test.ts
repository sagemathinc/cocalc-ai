import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { AgentStore } from "./store";
import { PersonalAgentStore, type PersonalAgentHooks } from "./personal-store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

// The name book keeps a snapshot of each named agent's identity, so listing
// is one local query; changes arrive from the agents' project bays and are
// pushed to the account's browsers as whole rows.
describeDb("live name book", () => {
  const account = randomUUID();
  const project = randomUUID();
  const agent = { project_id: project, agent_id: randomUUID() };
  const db = new AgentStore();
  let live: AgentIdentity;
  const identity = jest.fn(async () => live);
  const watch = jest.fn(async () => {});
  const upserts: NamedAgent[] = [];
  const removes: unknown[] = [];
  const hooks: PersonalAgentHooks = {
    watch,
    upsert: async (_account, row) => {
      upserts.push(row);
    },
    remove: async (_account, endpoint) => {
      removes.push(endpoint);
    },
    payments: async (_account, agents) => {
      for (const row of agents)
        row.payment = [
          {
            project_id: row.endpoint.project_id,
            thread_id: row.thread_id,
            provider: "codex",
            selection: {
              version: 1,
              provider: "codex",
              mode: "credential",
              credential_id: "00000000-0000-4000-8000-000000000001",
            },
            updated_at: new Date(0).toISOString(),
          },
        ];
    },
  };
  const store = new PersonalAgentStore(
    db,
    identity,
    async () => account,
    async () => {},
    async () => false,
    undefined,
    hooks,
  );

  beforeAll(async () => {
    await syncSchema({
      agent_personal_controls: SCHEMA.agent_personal_controls,
      agent_personal_names: SCHEMA.agent_personal_names,
    });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM agent_personal_names");
    upserts.length = 0;
    removes.length = 0;
    watch.mockClear();
    identity.mockClear();
    live = {
      ...agent,
      path: "/home/user/a.chat",
      thread_id: "t1",
      name: "builder",
      created_by: account,
      disabled_at: null,
      appearance: { name: "Builder", thread_color: "#123456" },
      runtime: { kind: "claude-code" },
    };
  });

  test("naming stores the identity snapshot, registers for changes and pushes the row", async () => {
    await store.name(account, { endpoint: agent, name: "builder" });
    expect(watch).toHaveBeenCalledWith(account, agent, true);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      name: "builder",
      thread_id: "t1",
      appearance: { name: "Builder" },
      runtime: { kind: "claude-code" },
      available: true,
      payment: [expect.objectContaining({ provider: "codex" })],
    });
  });

  test("listing reads only the snapshot: no identity lookups", async () => {
    await store.name(account, { endpoint: agent, name: "builder" });
    identity.mockClear();
    const names = await store.names(account);
    expect(identity).not.toHaveBeenCalled();
    expect(names[0]).toMatchObject({
      thread_id: "t1",
      runtime: { kind: "claude-code" },
      payment: [expect.objectContaining({ provider: "codex" })],
    });
  });

  test("a reported identity change updates the snapshot and pushes it", async () => {
    await store.name(account, { endpoint: agent, name: "builder" });
    upserts.length = 0;
    await store.applyIdentityChange(account, agent, {
      path: "/home/user/a.chat",
      thread_id: "t2",
      appearance: null,
      runtime: { kind: "claude-code" },
      available: true,
    });
    expect(upserts).toEqual([
      expect.objectContaining({ thread_id: "t2", name: "builder" }),
    ]);
    expect((await store.names(account))[0].thread_id).toBe("t2");
  });

  test("a change for an agent no longer named here unregisters", async () => {
    await store.applyIdentityChange(account, agent, {
      path: "/home/user/a.chat",
      thread_id: "t2",
      available: true,
    });
    expect(upserts).toHaveLength(0);
    expect(watch).toHaveBeenCalledWith(account, agent, false);
  });

  test("removing unregisters and pushes the removal", async () => {
    await store.name(account, { endpoint: agent, name: "builder" });
    await store.retire(account, { endpoint: agent });
    expect(watch).toHaveBeenLastCalledWith(account, agent, false);
    expect(removes).toEqual([agent]);
  });

  test("repair fixes stale snapshots and pushes only real changes", async () => {
    await store.name(account, { endpoint: agent, name: "builder" });
    upserts.length = 0;
    await store.repair(account);
    expect(upserts).toHaveLength(0);
    live = { ...live, thread_id: "t3", disabled_at: new Date() };
    await store.repair(account);
    expect(upserts).toEqual([
      expect.objectContaining({ thread_id: "t3", available: false }),
    ]);
  });
});
