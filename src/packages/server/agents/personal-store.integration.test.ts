import { randomUUID } from "node:crypto";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import type { AgentRpcBroadcast } from "@cocalc/conat/agents/rpc";
import { AgentStore } from "./store";
import { PersonalAgentStore } from "./personal-store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;

describeDb("account-home Agent Sessions", () => {
  const account = randomUUID();
  const project = randomUUID();
  const otherProject = randomUUID();
  const source = { project_id: project, agent_id: randomUUID() };
  const peer = { project_id: project, agent_id: randomUUID() };
  const secondPeer = { project_id: project, agent_id: randomUUID() };
  const remote = { project_id: otherProject, agent_id: randomUUID() };
  const run_id = randomUUID();
  const db = new AgentStore();
  const identity = jest.fn(
    async (_account, endpoint) =>
      ({
        ...endpoint,
        path: "/home/user/test.chat",
        thread_id: endpoint.agent_id,
        created_by: account,
      }) as AgentIdentity,
  );
  const principal = jest.fn(async () => account);
  const store = new PersonalAgentStore(db, identity, principal, async () => {});
  const tables = [
    "agent_personal_controls",
    "agent_personal_names",
    "agent_sessions",
    "agent_session_members",
    "agent_session_mutations",
    "agent_session_activity",
    "agent_session_proposals",
    "agent_session_broadcasts",
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
    identity.mockClear();
    principal.mockReset().mockResolvedValue(account);
    for (const [endpoint, name] of [
      [source, "builder"],
      [peer, "reviewer"],
      [secondPeer, "tester"],
      [remote, "remote"],
    ] as const)
      await store.name(account, { endpoint, name });
  });

  test("one session authorizes every direction but no nonmember", async () => {
    const session = await store.createSession(
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
      store.checkSession(
        account,
        session.agent_session_id,
        source,
        run_id,
        peer,
      ),
    ).resolves.toMatchObject({ delivery_mode: "queued" });
    await expect(
      store.checkSession(
        account,
        session.agent_session_id,
        peer,
        run_id,
        source,
      ),
    ).resolves.toMatchObject({ agent_session_id: session.agent_session_id });
    await expect(
      store.checkSession(
        account,
        session.agent_session_id,
        source,
        run_id,
        secondPeer,
      ),
    ).rejects.toThrow("not_a_member");
  });

  test("retiring a named agent frees its slot without deleting session history", async () => {
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );

    await store.retire(account, { endpoint: source });

    await expect(store.names(account)).resolves.toHaveLength(3);
    const preserved = (await store.sessions(account, 100)).sessions.find(
      ({ agent_session_id }) => agent_session_id === session.agent_session_id,
    );
    expect(preserved).toBeDefined();
    expect(
      preserved?.members.find(
        ({ kind, member_id }) =>
          kind === "registered" && member_id === source.agent_id,
      ),
    ).toMatchObject({ available: false });
    await expect(
      store.checkSession(
        account,
        session.agent_session_id,
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
      store.createSession(account, options, 8),
      store.createSession(account, options, 8),
    ]);
    expect(second.agent_session_id).toBe(first.agent_session_id);
    expect(
      +(
        await db.query(
          "SELECT count(*) AS count FROM agent_sessions WHERE account_id=$1",
          [account],
        )
      ).rows[0].count,
    ).toBe(1);
    await expect(
      store.createSession(account, { ...options, title: "Changed" }, 8),
    ).rejects.toThrow("session_mutation_idempotency_conflict");
  });

  test("fresh auth tracks project-set expansion, not every added agent", async () => {
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await expect(
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "add-member",
          member: { kind: "registered", endpoint: secondPeer },
        },
        8,
      ),
    ).resolves.toMatchObject({ members: expect.any(Array) });
    await expect(
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "add-member",
          member: { kind: "registered", endpoint: remote },
        },
        8,
      ),
    ).rejects.toThrow("fresh_auth_required");
    await expect(
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "add-member",
          member: { kind: "registered", endpoint: remote },
        },
        8,
        true,
      ),
    ).resolves.toMatchObject({ members: expect.any(Array) });
  });

  test("an external installation can join only its exact approved session", async () => {
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
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
       (installation_id,account_id,agent_id,label,secret_hash,state,generation,approval,agent_session_id,expires_at)
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
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "add-member",
          member: { kind: "external", agent_id, installation_id },
        },
        8,
      ),
    ).rejects.toThrow("external_identity_unavailable");
  });

  test("mutation rate limits expansion but never blocks restrictive closure", async () => {
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await db.query(
      `INSERT INTO agent_session_mutations
       (account_id,request_id,binding_hash,agent_session_id)
       SELECT $1,md5(i::text)::uuid,'rate-fixture',$2
       FROM generate_series(1,999) AS i`,
      [account, session.agent_session_id],
    );
    await expect(
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "add-member",
          member: { kind: "registered", endpoint: secondPeer },
        },
        8,
      ),
    ).rejects.toThrow("agent_session_mutation_rate_limited");
    await expect(
      store.updateSession(
        account,
        {
          request_id: randomUUID(),
          agent_session_id: session.agent_session_id,
          action: "close",
        },
        8,
      ),
    ).resolves.toMatchObject({ state: "closed" });
  });

  test("pause and account revoke block both directions", async () => {
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
        members: [
          { kind: "registered", endpoint: source },
          { kind: "registered", endpoint: peer },
        ],
      },
      8,
    );
    await store.updateSession(
      account,
      {
        request_id: randomUUID(),
        agent_session_id: session.agent_session_id,
        action: "pause",
      },
      8,
    );
    await expect(
      store.checkSession(
        account,
        session.agent_session_id,
        source,
        run_id,
        peer,
      ),
    ).rejects.toThrow("session_paused");
    await store.setControls(account, { action: "revoke_all" });
    expect((await store.sessions(account)).active_count).toBe(0);
  });

  test("agent proposals are inert, bounded, and human-resolved", async () => {
    const proposal = await store.proposeSession(
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
    expect((await store.sessions(account)).sessions).toHaveLength(0);
    await expect(
      store.proposeSession(
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
    const session = await store.createSession(
      account,
      {
        request_id: randomUUID(),
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
      agent_session_id: session.agent_session_id,
      targets: [peer, secondPeer],
      body: "Review",
    };
    await expect(
      store.beginBroadcast(account, source, run_id, broadcast),
    ).resolves.toMatchObject({ claimed: true });
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
});
