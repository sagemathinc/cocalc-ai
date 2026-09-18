import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema/sync";
import { SCHEMA } from "@cocalc/util/db-schema";
import type { AgentIdentity } from "@cocalc/conat/agents/protocol";
import { AgentStore } from "./store";
import { PersonalAgentStore } from "./personal-store";

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("account-home personal names, grants and approval requests", () => {
  const account = randomUUID(),
    other = randomUUID();
  const source = { project_id: randomUUID(), agent_id: randomUUID() };
  const target = { project_id: randomUUID(), agent_id: randomUUID() };
  const third = { project_id: randomUUID(), agent_id: randomUUID() };
  const run_id = randomUUID();
  const db = new AgentStore();
  const identity = jest.fn(
    async (_account, endpoint) =>
      ({
        ...endpoint,
        path: "/home/user/test.chat",
        thread_id: "thread",
        created_by: other,
      }) as AgentIdentity,
  );
  const principal = jest.fn(async () => account);
  // Account fencing has separate integration coverage with real account rows.
  const store = new PersonalAgentStore(db, identity, principal, async () => {});
  const approval = (extra = {}) => ({
    source,
    target,
    reason: "review",
    approval_request_id: randomUUID(),
    ...extra,
  });
  const request = (extra = {}) => ({
    source,
    target,
    run_id,
    reason: "review",
    request_id: randomUUID(),
    ...extra,
  });
  const tables = [
    "agent_personal_controls",
    "agent_personal_names",
    "agent_personal_grants",
    "agent_personal_requests",
  ];

  beforeAll(async () => {
    await syncSchema(
      Object.fromEntries(tables.map((name) => [name, SCHEMA[name]])),
    );
  });
  beforeEach(async () => {
    for (const table of tables) await db.query(`DELETE FROM ${table}`);
    identity.mockClear();
    identity.mockImplementation(
      async (_account, endpoint) =>
        ({
          ...endpoint,
          path: "/home/user/test.chat",
          thread_id: "thread",
          created_by: other,
        }) as AgentIdentity,
    );
    principal.mockReset().mockResolvedValue(account);
  });

  test("normalization, per-human namespaces, tombstones, and bound identity survive rename", async () => {
    await store.name(account, { endpoint: target, name: "Reviewer" });
    await store.name(other, { endpoint: third, name: "reviewer" });
    const grant = await store.grant(account, approval());
    await store.name(account, { endpoint: target, name: "reviewer-new" });
    await expect(
      store.name(account, { endpoint: third, name: "reviewer" }),
    ).rejects.toThrow("name_reserved");
    await expect(store.resolveName(account, "reviewer")).rejects.toThrow(
      "name_renamed:reviewer-new",
    );
    expect(await store.check(account, source, target, false)).toMatchObject({
      link_id: grant[0].link_id,
      target_name: "reviewer-new",
      target_retired_names: ["reviewer"],
    });
    expect(await store.names(other)).toMatchObject([
      { name: "reviewer", endpoint: third },
    ]);
    for (const name of [
      "all",
      "me",
      "everyone",
      "agents",
      "1test",
      "a_",
      "-foo",
      "foo-",
      "a".repeat(33),
    ])
      await expect(
        store.name(account, { endpoint: target, name }),
      ).rejects.toThrow();
  });

  test("concurrent creation/rename is serialized and DB enforces one current endpoint", async () => {
    const results = await Promise.allSettled([
      store.name(account, { endpoint: target, name: "reviewer" }),
      store.name(account, { endpoint: third, name: "reviewer" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await Promise.all([
      store.name(account, { endpoint: source, name: "builder" }),
      store.name(account, { endpoint: source, name: "builder-new" }),
    ]);
    expect(
      (await store.names(account)).filter(
        (n) => n.endpoint.agent_id === source.agent_id,
      ),
    ).toHaveLength(1);
    await expect(
      db.query(
        "INSERT INTO agent_personal_names(account_id,name,project_id,agent_id,metadata) VALUES($1,'duplicate',$2,$3,'{}')",
        [account, source.project_id, source.agent_id],
      ),
    ).rejects.toThrow();
  });

  test("membership limit blocks new endpoints, permits rename, and retirement frees a slot", async () => {
    await store.name(account, { endpoint: source, name: "builder" }, 1);
    await expect(
      store.name(account, { endpoint: target, name: "reviewer" }, 1),
    ).rejects.toThrow("named_agent_limit_reached:1:1");

    await expect(
      store.name(account, { endpoint: source, name: "builder-new" }, 1),
    ).resolves.toMatchObject({ name: "builder-new", endpoint: source });

    await store.retire(account, { endpoint: source });
    await expect(
      store.name(account, { endpoint: target, name: "reviewer" }, 1),
    ).resolves.toMatchObject({ name: "reviewer", endpoint: target });
    expect(await store.names(account)).toHaveLength(1);
  });

  test("unavailable targets retain metadata and listing never starts execution", async () => {
    await store.name(account, { endpoint: target, name: "reviewer" });
    identity.mockRejectedValue(new Error("owner unavailable"));
    expect(await store.names(account)).toMatchObject([
      { name: "reviewer", available: false, path: "/home/user/test.chat" },
    ]);
    expect(principal).not.toHaveBeenCalled();
  });

  test("both directions share one generation/group and null expiry; registrant is not execution principal", async () => {
    const opts = approval({ both_directions: true, ttl_seconds: null });
    const grants = await store.grant(account, opts);
    expect(grants).toHaveLength(2);
    expect(new Set(grants.map((g) => g.direction_group_id)).size).toBe(1);
    for (const grant of grants)
      expect(grant).toMatchObject({
        expires_at: null,
        principal_account_id: account,
        approved_by: account,
        status: "active",
      });
    expect(await store.check(account, target, source, false)).toMatchObject({
      target: source,
    });
    expect(
      (await store.grant(account, opts)).map((g) => g.link_id).sort(),
    ).toEqual(grants.map((g) => g.link_id).sort());
    await expect(
      store.grant(account, { ...opts, ttl_seconds: 1 }),
    ).rejects.toThrow("approval_request_conflict");
    await expect(store.check(other, source, target, false)).rejects.toThrow(
      "approval_required",
    );
    expect(await store.links(other, source)).toEqual([]);
  });

  test("bidirectional validation failure records neither direction", async () => {
    identity.mockImplementation(async (_a, endpoint) => {
      if (endpoint.agent_id === target.agent_id) throw new Error("no access");
      return { ...endpoint } as AgentIdentity;
    });
    await expect(
      store.grant(account, approval({ both_directions: true })),
    ).rejects.toThrow("no access");
    expect(await store.connections(account)).toEqual([]);
  });

  test("a database failure on the reverse insert rolls back the forward grant", async () => {
    await getPool().query(
      `ALTER TABLE agent_personal_grants ADD CONSTRAINT test_reverse_failure CHECK(source_agent_id<>'${target.agent_id}'::uuid)`,
    );
    try {
      await expect(
        store.grant(account, approval({ both_directions: true })),
      ).rejects.toThrow();
      expect(await store.connections(account)).toEqual([]);
    } finally {
      await getPool().query(
        "ALTER TABLE agent_personal_grants DROP CONSTRAINT test_reverse_failure",
      );
    }
  });

  test("expiry, guidance, access removal, pause/resume and revoke are independent", async () => {
    const [grant] = await store.grant(account, approval());
    await expect(store.check(account, source, target, true)).rejects.toThrow(
      "approval_required",
    );
    await db.query(
      "UPDATE agent_personal_grants SET expires_at=now()-interval '1 second'",
    );
    await expect(store.check(account, source, target, false)).rejects.toThrow(
      "grant_expired",
    );
    expect(await store.connections(account)).toMatchObject([
      { status: "expired" },
    ]);
    await db.query("UPDATE agent_personal_grants SET expires_at=NULL");
    await store.setConnection(account, {
      direction_group_id: grant.direction_group_id,
      state: "paused",
    });
    await expect(store.check(account, source, target, false)).rejects.toThrow(
      "grant_paused",
    );
    await store.setConnection(account, {
      direction_group_id: grant.direction_group_id,
      state: "active",
    });
    identity.mockRejectedValueOnce(new Error("access removed"));
    await expect(store.check(account, source, target, false)).rejects.toThrow(
      "access removed",
    );
    await expect(
      store.setConnection(other, {
        direction_group_id: grant.direction_group_id,
        state: "revoked",
      }),
    ).rejects.toThrow("connection_not_found");
    await store.setConnection(account, {
      direction_group_id: grant.direction_group_id,
      state: "revoked",
    });
    await expect(
      store.setConnection(account, {
        direction_group_id: grant.direction_group_id,
        state: "active",
      }),
    ).rejects.toThrow("grant_revoked");
  });

  test("account controls are authoritative and new approval does not override pause", async () => {
    const [old] = await store.grant(account, approval());
    await store.grant(other, approval());
    await store.setControls(account, { action: "pause" });
    expect(
      await store.grant(account, approval({ ttl_seconds: null })),
    ).toMatchObject([{ status: "paused" }]);
    expect(await store.links(account, source)).toEqual([]);
    expect(await store.links(other, source)).toHaveLength(1);
    await store.setControls(account, { action: "revoke_all" });
    expect(await store.setControls(account, { action: "resume" })).toEqual({
      paused: false,
      generation: 1,
    });
    await expect(store.check(account, source, target, false)).rejects.toThrow(
      "grant_revoked",
    );
    await expect(
      store.setConnection(account, {
        direction_group_id: old.direction_group_id,
        state: "active",
      }),
    ).rejects.toThrow("grant_revoked");
    expect(await store.grant(account, approval())).toMatchObject([
      { status: "active", generation: 1 },
    ]);
  });

  test("discovery exposes only approved endpoints' exact names", async () => {
    await store.name(account, { endpoint: third, name: "private-contact" });
    await store.name(account, { endpoint: target, name: "reviewer" });
    await store.grant(account, approval());
    const links = await store.links(account, source);
    expect(links).toMatchObject([
      { target_name: "reviewer", target_named_agent: { endpoint: target } },
    ]);
    expect(JSON.stringify(links)).not.toContain("private-contact");
  });

  test("request is run-bound, coalesced, principal-private and approval records grants without sending", async () => {
    const opts = request({ both_directions: true, ttl_seconds: null });
    const pending = await store.request(account, opts);
    expect(
      await store.request(account, { ...opts, request_id: randomUUID() }),
    ).toEqual(pending);
    await expect(store.readRequest(other, pending.request_id)).rejects.toThrow(
      "connection_request_not_found",
    );
    await expect(
      store.readRequest(account, pending.request_id, {
        source,
        run_id: randomUUID(),
      }),
    ).rejects.toThrow("connection_request_not_found");
    await expect(
      store.resolveRequest(other, pending.request_id, "approve"),
    ).rejects.toThrow("connection_request_not_found");
    await expect(
      store.grant(
        account,
        approval({ approval_request_id: pending.request_id }),
      ),
    ).rejects.toThrow("use resolvePersonalConnectionRequest");
    expect(await store.connections(account)).toEqual([]);
    expect(
      await store.resolveRequest(account, pending.request_id, "approve"),
    ).toMatchObject({ state: "approved" });
    expect(await store.connections(account)).toHaveLength(2);
    await store.resolveRequest(account, pending.request_id, "approve");
    expect(await store.connections(account)).toHaveLength(2);
  });

  test("expired, denied and invalidated requests never create grants", async () => {
    const first = await store.request(account, request());
    await db.query(
      "UPDATE agent_personal_requests SET expires_at=now()-interval '1 second'",
    );
    expect(
      await store.resolveRequest(account, first.request_id, "approve"),
    ).toMatchObject({ state: "expired" });
    const second = await store.request(account, request());
    expect(
      await store.resolveRequest(account, second.request_id, "deny"),
    ).toMatchObject({ state: "denied" });
    const thirdRequest = await store.request(account, request());
    principal.mockRejectedValue(new Error("run ended"));
    expect(
      await store.resolveRequest(account, thirdRequest.request_id, "approve"),
    ).toMatchObject({ state: "invalidated" });
    expect(await store.connections(account)).toEqual([]);
  });

  test("request creation rejects principal mismatch and intentional revocation; throttles spam", async () => {
    principal.mockResolvedValueOnce(other);
    await expect(store.request(account, request())).rejects.toThrow(
      "principal_mismatch",
    );
    const [grant] = await store.grant(account, approval());
    await store.setConnection(account, {
      direction_group_id: grant.direction_group_id,
      state: "paused",
    });
    await expect(store.request(account, request())).rejects.toThrow(
      "grant_paused",
    );
    await store.setConnection(account, {
      direction_group_id: grant.direction_group_id,
      state: "revoked",
    });
    await expect(store.request(account, request())).rejects.toThrow(
      "grant_revoked",
    );
    for (let i = 0; i < 10; i++)
      await store.request(
        account,
        request({ target: third, reason: `request-${i}` }),
      );
    await expect(
      store.request(account, request({ target: third, reason: "overflow" })),
    ).rejects.toThrow("rate_limited");
  });

  test.each(["pause", "generation", "reverse-revoke", "expiry"] as const)(
    "approval rechecks %s changed while remote principal validation was outstanding",
    async (change) => {
      const [reverse] = await store.grant(
        account,
        approval({ source: target, target: source }),
      );
      const pending = await store.request(
        account,
        request({ both_directions: true }),
      );
      principal.mockImplementationOnce(async () => {
        // Change only the authoritative row, leaving the prompt pending, to
        // exercise the lock-time recheck rather than eager invalidation.
        if (change === "pause")
          await db.query(
            "UPDATE agent_personal_controls SET paused=true WHERE account_id=$1",
            [account],
          );
        else if (change === "generation")
          await db.query(
            "UPDATE agent_personal_controls SET generation=generation+1 WHERE account_id=$1",
            [account],
          );
        else if (change === "reverse-revoke")
          await db.query(
            "UPDATE agent_personal_grants SET revoked_at=now() WHERE link_id=$1",
            [reverse.link_id],
          );
        else
          await db.query(
            "UPDATE agent_personal_requests SET expires_at=now()-interval '1 second' WHERE request_id=$1",
            [pending.request_id],
          );
        return account;
      });
      expect(
        await store.resolveRequest(account, pending.request_id, "approve"),
      ).toMatchObject({
        state: change === "expiry" ? "expired" : "invalidated",
      });
      expect(await store.connections(account)).toHaveLength(1);
    },
  );

  test.each(["pause", "revoke_all"] as const)(
    "account %s invalidates pending approval instead of restoring permission",
    async (action) => {
      const pending = await store.request(account, request());
      await store.setControls(account, { action });
      expect(
        await store.resolveRequest(account, pending.request_id, "approve"),
      ).toMatchObject({ state: "invalidated" });
      expect(await store.connections(account)).toEqual([]);
    },
  );

  test.each(["paused", "revoked"] as const)(
    "a %s reverse connection invalidates pending bidirectional approval",
    async (state) => {
      const [reverse] = await store.grant(
        account,
        approval({ source: target, target: source }),
      );
      const pending = await store.request(
        account,
        request({ both_directions: true }),
      );
      await store.setConnection(account, {
        direction_group_id: reverse.direction_group_id,
        state,
      });
      expect(
        await store.resolveRequest(account, pending.request_id, "approve"),
      ).toMatchObject({ state: "invalidated" });
      expect(await store.connections(account)).toHaveLength(1);
      await expect(
        store.request(account, request({ both_directions: true })),
      ).rejects.toThrow(`grant_${state}`);
    },
  );

  test("activity is principal-scoped, bounded metadata and does not imply completion", async () => {
    const [grant] = await store.grant(account, approval());
    await store.observe(other, grant.link_id, true);
    expect(await store.connections(account)).toMatchObject([
      { last_attempt_at: null, last_accepted_at: null },
    ]);
    await store.observe(account, grant.link_id, false);
    expect(await store.connections(account)).toMatchObject([
      { last_attempt_at: expect.any(String), last_accepted_at: null },
    ]);
    await store.observe(account, grant.link_id, true);
    expect(await store.connections(account)).toMatchObject([
      { last_accepted_at: expect.any(String) },
    ]);
  });

  test("new-generation requests do not coalesce to pre-revocation prompts", async () => {
    const old = await store.request(account, request());
    await store.setControls(account, { action: "revoke_all" });
    const next = await store.request(account, request());
    expect(next.request_id).not.toBe(old.request_id);
    expect(next.generation).toBe(old.generation + 1);
    expect(
      await store.resolveRequest(account, old.request_id, "approve"),
    ).toMatchObject({ state: "invalidated" });
    expect(
      await store.resolveRequest(account, next.request_id, "approve"),
    ).toMatchObject({ state: "approved" });
  });

  test.each(["approved", "denied", "expired", "invalidated"] as const)(
    "coalesced submitted IDs remain inspectable/idempotent after %s",
    async (state) => {
      const first = request();
      const second = { ...first, request_id: randomUUID() };
      await store.request(account, first);
      expect(await store.request(account, second)).toMatchObject({
        request_id: first.request_id,
      });
      if (state === "expired")
        await db.query(
          "UPDATE agent_personal_requests SET expires_at=now()-interval '1 second'",
        );
      else if (state === "invalidated")
        await store.setControls(account, { action: "revoke_all" });
      else
        await store.resolveRequest(
          account,
          first.request_id,
          state === "approved" ? "approve" : "deny",
        );
      expect(await store.request(account, second)).toMatchObject({
        request_id: first.request_id,
        state,
      });
      expect(
        await store.readRequest(account, second.request_id, { source, run_id }),
      ).toMatchObject({
        request_id: second.request_id,
        canonical_request_id: first.request_id,
        state,
      });
      expect(await store.requests(account)).toHaveLength(1);
      expect(await store.connections(account)).toHaveLength(
        state === "approved" ? 1 : 0,
      );
      await expect(store.readRequest(other, second.request_id)).rejects.toThrow(
        "not_found",
      );
      await expect(
        store.request(account, { ...second, reason: "different" }),
      ).rejects.toThrow("conflict");
    },
  );

  test("an alias resolves only the canonical approval, never another grant", async () => {
    const first = request({ both_directions: true });
    const second = { ...first, request_id: randomUUID() };
    await store.request(account, first);
    await store.request(account, second);
    expect(
      await store.resolveRequest(account, second.request_id, "approve"),
    ).toMatchObject({ request_id: first.request_id, state: "approved" });
    await store.resolveRequest(account, first.request_id, "approve");
    expect(await store.connections(account)).toHaveLength(2);
    await expect(
      store.grant(
        account,
        approval({ approval_request_id: second.request_id }),
      ),
    ).rejects.toThrow("use resolvePersonalConnectionRequest");
  });

  test("scoped request IDs cannot reuse a previous ordinary approval ID", async () => {
    const opts = approval();
    await store.grant(account, opts);
    await expect(
      store.request(account, request({ request_id: opts.approval_request_id })),
    ).rejects.toThrow("connection_request_conflict");
    expect(await store.requests(account)).toEqual([]);
  });

  test("revoking an older matching grant invalidates the prompt even when the newest grant expired", async () => {
    const [older] = await store.grant(account, approval());
    const [newer] = await store.grant(account, approval());
    await db.query(
      "UPDATE agent_personal_grants SET created_at=now()-interval '1 day' WHERE link_id=$1",
      [older.link_id],
    );
    await db.query(
      "UPDATE agent_personal_grants SET expires_at=now()-interval '1 second' WHERE link_id=$1",
      [newer.link_id],
    );
    const pending = await store.request(account, request());
    await store.setConnection(account, {
      direction_group_id: older.direction_group_id,
      state: "revoked",
    });
    expect(await store.readRequest(account, pending.request_id)).toMatchObject({
      state: "invalidated",
    });
    expect(
      await store.resolveRequest(account, pending.request_id, "approve"),
    ).toMatchObject({ state: "invalidated" });
    expect(await store.connections(account)).toHaveLength(2);
  });

  test("pause/resume does not revive pending prompts and another account remains independent", async () => {
    const pending = await store.request(account, request());
    principal.mockResolvedValueOnce(other);
    const theirs = await store.request(other, request());
    await store.setControls(account, { action: "pause" });
    await store.setControls(account, { action: "resume" });
    expect(await store.readRequest(account, pending.request_id)).toMatchObject({
      state: "invalidated",
    });
    expect(await store.readRequest(other, theirs.request_id)).toMatchObject({
      state: "pending",
    });
  });

  test("recent terminal history cannot hide an older actionable prompt", async () => {
    const pending = await store.request(account, request());
    await db.query(
      `INSERT INTO agent_personal_requests(request_id,account_id,source_project_id,source_agent_id,run_id,request,state,expires_at,created_at)
      SELECT gen_random_uuid(),r.account_id,r.source_project_id,r.source_agent_id,r.run_id,r.request,'denied',r.expires_at,r.created_at+interval '1 second'
      FROM agent_personal_requests r CROSS JOIN generate_series(1,210) WHERE r.request_id=$1`,
      [pending.request_id],
    );
    const listed = await store.requests(account);
    expect(listed).toHaveLength(200);
    expect(listed[0]).toMatchObject({
      request_id: pending.request_id,
      state: "pending",
    });
  });
});
