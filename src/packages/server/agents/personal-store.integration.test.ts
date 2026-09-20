import { randomUUID } from "node:crypto";
import type { PoolClient } from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { AgentRpcBroadcast } from "@cocalc/conat/agents/rpc";
import { AgentStore } from "./store";
import { PersonalAgentStore } from "./personal-store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

class TrackingAgentStore extends AgentStore {
  transactionDepth = 0;

  override async transaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return super.transaction(async (client) => {
      this.transactionDepth++;
      try {
        return await fn(client);
      } finally {
        this.transactionDepth--;
      }
    });
  }
}

describeDb("account-home Agent Networks", () => {
  const account = randomUUID();
  const project = randomUUID();
  const otherProject = randomUUID();
  const source = { project_id: project, agent_id: randomUUID() };
  const peer = { project_id: project, agent_id: randomUUID() };
  const secondPeer = { project_id: project, agent_id: randomUUID() };
  const remote = { project_id: otherProject, agent_id: randomUUID() };
  const run_id = randomUUID();
  const db = new TrackingAgentStore();
  const identityResult = async (_account: string, endpoint) =>
    ({
      ...endpoint,
      path: "/home/user/test.chat",
      thread_id: endpoint.agent_id,
      created_by: account,
    }) as AgentIdentity;
  const identity = jest.fn(identityResult);
  const principal = jest.fn(async () => account);
  const store = new PersonalAgentStore(db, identity, principal, async () => {});
  const tables = [
    "agent_personal_controls",
    "agent_personal_names",
    "agent_networks",
    "agent_network_members",
    "agent_network_mutations",
    "agent_network_activity",
    "agent_network_proposals",
    "agent_network_broadcasts",
    "agent_external_identities",
    "agent_external_installations",
    "agent_external_inbox",
  ];

  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });

  beforeEach(async () => {
    for (const table of tables.slice().reverse())
      await db.query(`DELETE FROM ${table}`);
    identity.mockReset().mockImplementation(identityResult);
    principal.mockReset().mockResolvedValue(account);
    for (const [endpoint, name] of [
      [source, "builder"],
      [peer, "reviewer"],
      [secondPeer, "tester"],
      [remote, "remote"],
    ] as const)
      await store.name(account, { endpoint, name });
  });

  test("one network authorizes every direction but no nonmember", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Review",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await expect(
      store.checkNetwork(
        account,
        network.agent_network_id,
        source,
        run_id,
        peer,
      ),
    ).resolves.toMatchObject({
      delivery_mode: "queued",
      network_title: "Review",
    });
    await expect(
      store.checkNetwork(
        account,
        network.agent_network_id,
        peer,
        run_id,
        source,
      ),
    ).resolves.toMatchObject({ agent_network_id: network.agent_network_id });
    await expect(
      store.checkNetwork(
        account,
        network.agent_network_id,
        source,
        run_id,
        secondPeer,
      ),
    ).rejects.toThrow("not_a_member");
  });

  test("retiring a named agent frees its slot without deleting network history", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Retirement history",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );

    await store.retire(account, { endpoint: source });

    await expect(store.names(account)).resolves.toHaveLength(3);
    const preserved = (await store.networks(account, 100)).networks.find(
      ({ agent_network_id }) => agent_network_id === network.agent_network_id,
    );
    expect(preserved).toBeDefined();
    expect(
      preserved?.members.find(
        ({ kind, member_id }) =>
          kind === "registered" && member_id === source.agent_id,
      ),
    ).toMatchObject({ available: false });
    await expect(
      store.checkNetwork(
        account,
        network.agent_network_id,
        source,
        run_id,
        peer,
      ),
    ).rejects.toThrow("not_a_member");

    await expect(
      store.name(account, { endpoint: source, name: "builder" }, 4),
    ).resolves.toMatchObject({ name: "builder" });
  });

  test("concurrent creation is idempotent and changed input cannot reuse its key", async () => {
    const request_id = randomUUID();
    const options = {
      request_id,
      title: "Concurrent review",
      members: [
        { kind: "registered" as const, endpoint: source },
        { kind: "registered" as const, endpoint: peer },
      ],
    };
    const [first, second] = await Promise.all([
      store.createNetwork(account, options, 8),
      store.createNetwork(account, options, 8),
    ]);
    expect(second.agent_network_id).toBe(first.agent_network_id);
    expect(
      +(
        await db.query(
          "SELECT count(*) AS count FROM agent_networks WHERE account_id=$1",
          [account],
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      store.createNetwork(account, { ...options, title: "Changed" }, 8),
    ).rejects.toThrow("network_mutation_idempotency_conflict");
  });

  test("management endpoint routing never occurs inside a transaction", async () => {
    const transactionDepths: number[] = [];
    identity.mockImplementation(async (_account, endpoint) => {
      transactionDepths.push(db.transactionDepth);
      return identityResult(_account, endpoint);
    });
    const create = {
      request_id: randomUUID(),
      title: "Unlocked routing",
      members: [
        { kind: "registered" as const, endpoint: source },
        { kind: "registered" as const, endpoint: peer },
      ],
    };
    const network = await store.createNetwork(account, create, 8);
    await store.createNetwork(account, create, 8);
    const update = {
      request_id: randomUUID(),
      agent_network_id: network.agent_network_id,
      action: "add-member" as const,
      member: { kind: "registered" as const, endpoint: secondPeer },
    };
    await store.updateNetwork(account, update, 8);
    await store.updateNetwork(account, update, 8);

    expect(transactionDepths.length).toBeGreaterThan(0);
    expect(transactionDepths.every((depth) => depth === 0)).toBe(true);
  });

  test("add-member fails closed when remote validation races a mutation", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Management generation race",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    identity.mockImplementation(async (_account, endpoint) => {
      if (endpoint.agent_id === secondPeer.agent_id)
        await db.query(
          "UPDATE agent_networks SET generation=$2 WHERE agent_network_id=$1",
          [network.agent_network_id, randomUUID()],
        );
      return identityResult(_account, endpoint);
    });

    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: secondPeer },
        },
        8,
      ),
    ).rejects.toThrow("network_stale");
    expect(
      +(
        await db.query(
          "SELECT count(*) AS count FROM agent_network_members WHERE agent_network_id=$1 AND member_id=$2 AND removed_at IS NULL",
          [network.agent_network_id, secondPeer.agent_id],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  test("fresh auth tracks project-set expansion, not every added agent", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Project expansion",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: secondPeer },
        },
        8,
      ),
    ).resolves.toMatchObject({ members: expect.any(Array) });
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: remote },
        },
        8,
      ),
    ).rejects.toThrow("fresh_auth_required");
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: remote },
        },
        8,
        true,
      ),
    ).resolves.toMatchObject({ members: expect.any(Array) });
  });

  test("an external installation can join only its exact approved network", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "External review",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    const agent_id = randomUUID();
    const installation_id = randomUUID();
    await db.query(
      "INSERT INTO agent_external_identities(agent_id,account_id,label) VALUES($1,$2,$3)",
      [agent_id, account, "External reviewer"],
    );
    await db.query(
      `INSERT INTO agent_external_installations
       (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,agent_network_id,expires_at)
       VALUES($1,$2,$3,$4,$5,'active',0,'[]'::jsonb,$6,now()+interval '1 hour')`,
      [
        installation_id,
        account,
        agent_id,
        "External reviewer",
        "0".repeat(64),
        randomUUID(),
      ],
    );
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "external", agent_id, installation_id },
        },
        8,
      ),
    ).rejects.toThrow("external_identity_unavailable");
  });

  test("mutation rate limits expansion but never blocks restrictive closure", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Rate limit",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await db.query(
      `INSERT INTO agent_network_mutations
       (account_id,request_id,binding_hash,agent_network_id)
       SELECT $1,md5(i::text)::uuid,'rate-fixture',$2
       FROM generate_series(1,999) AS i`,
      [account, network.agent_network_id],
    );
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "add-member",
          member: { kind: "registered", endpoint: secondPeer },
        },
        8,
      ),
    ).rejects.toThrow("agent_network_mutation_rate_limited");
    await expect(
      store.updateNetwork(
        account,
        {
          request_id: randomUUID(),
          agent_network_id: network.agent_network_id,
          action: "close",
        },
        8,
      ),
    ).resolves.toMatchObject({ state: "closed" });
  });

  test("pause and account revoke block both directions", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Pause and revoke",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await store.updateNetwork(
      account,
      {
        request_id: randomUUID(),
        agent_network_id: network.agent_network_id,
        action: "pause",
      },
      8,
    );
    await expect(
      store.checkNetwork(
        account,
        network.agent_network_id,
        source,
        run_id,
        peer,
      ),
    ).rejects.toThrow("network_paused");
    await store.setControls(account, { action: "revoke_all" });
    expect((await store.networks(account)).active_count).toBe(0);
  });

  test("agent proposals are inert, bounded, and human-resolved", async () => {
    const proposal = await store.proposeNetwork(
      account,
      source,
      run_id,
      {
        proposal_id: randomUUID(),
        title: "Proposed review",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
        reason: "Need an independent review",
      },
      8,
    );
    expect(proposal.state).toBe("pending");
    expect((await store.networks(account)).networks).toHaveLength(0);
    await expect(
      store.proposeNetwork(
        account,
        source,
        run_id,
        {
          ...proposal,
          proposal_id: proposal.proposal_id,
          members: [
            { kind: "registered", endpoint: source },
            { kind: "registered", endpoint: secondPeer },
          ],
        },
        8,
      ),
    ).rejects.toThrow("proposal_idempotency_conflict");
    await expect(
      store.finishProposal(account, proposal.proposal_id, "rejected"),
    ).resolves.toMatchObject({ state: "rejected" });
  });

  test("broadcast parent idempotency binds body and target order", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Broadcast review",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
          { kind: "registered", endpoint: secondPeer },
        ],
      },
      8,
    );
    const broadcast: AgentRpcBroadcast = {
      version: 3,
      action: "broadcast",
      broadcast_id: randomUUID(),
      agent_network_id: network.agent_network_id,
      targets: [peer, secondPeer],
      body: "Review",
    };
    identity.mockClear();
    principal.mockClear();
    await expect(
      store.beginBroadcast(account, source, run_id, broadcast),
    ).resolves.toMatchObject({ claimed: true });
    expect(principal).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(3);
    await expect(
      store.beginBroadcast(account, source, run_id, broadcast),
    ).resolves.toMatchObject({ claimed: false });
    await expect(
      store.beginBroadcast(account, source, run_id, {
        ...broadcast,
        body: "Changed",
      }),
    ).rejects.toThrow("broadcast_idempotency_conflict");
  });

  test("broadcast generation changes during endpoint checks fail closed", async () => {
    const network = await store.createNetwork(
      account,
      {
        request_id: randomUUID(),
        title: "Generation race",
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
          { kind: "registered", endpoint: secondPeer },
        ],
      },
      8,
    );
    let changed = false;
    identity.mockImplementation(async (_account, endpoint) => {
      if (!changed && endpoint.agent_id === peer.agent_id) {
        changed = true;
        await db.query(
          "UPDATE agent_networks SET generation=$2 WHERE agent_network_id=$1",
          [network.agent_network_id, randomUUID()],
        );
      }
      return {
        ...endpoint,
        path: "/home/user/test.chat",
        thread_id: endpoint.agent_id,
        created_by: account,
      } as AgentIdentity;
    });
    await expect(
      store.beginBroadcast(account, source, run_id, {
        version: 3,
        action: "broadcast",
        broadcast_id: randomUUID(),
        agent_network_id: network.agent_network_id,
        targets: [peer, secondPeer],
        body: "Review",
      }),
    ).rejects.toThrow("network_stale");
    expect(
      +(
        await db.query(
          "SELECT count(*) AS count FROM agent_network_broadcasts WHERE agent_network_id=$1",
          [network.agent_network_id],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
