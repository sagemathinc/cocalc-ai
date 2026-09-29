/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("account-home People demand store (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  const demand = (operation: string, opts = {}) =>
    env.worker("a").call("demand", { operation, opts });
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    await demand("install");
    await env.worker("b").call("demand", { operation: "install" });
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  beforeEach(async () => {
    await env.sql("a", "DELETE FROM collaboration_demand");
    await env.sql("a", "DELETE FROM collaboration_demand_activation");
    await env.sql("a", "DELETE FROM collaboration_access");
  });

  test("authenticated demand calls bind the caller and cannot release another account's lease", async () => {
    const first = await env.hub("a", "acquireDemand", {
      account_id: env.accounts[1],
      consumer_id: randomUUID(),
      scope: { kind: "all" },
    });
    expect((await env.hub("a", "inspectDemand", {})).active_consumers).toBe(1);
    expect((await env.hub("b", "inspectDemand", {})).active_consumers).toBe(0);
    expect(
      await env.hub("b", "releaseDemand", {
        ...first,
        account_id: env.accounts[0],
      }),
    ).toEqual({ released: false });
    expect((await env.hub("a", "renewDemand", first)).renewed).toBe(false);
    expect(await env.hub("a", "releaseDemand", first)).toEqual({
      released: true,
    });
    expect((await env.hub("a", "inspectDemand", {})).state).toBe("grace");
    expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
  });

  test("retry and early renewal do not extend the lease; scopes are canonical", async () => {
    const consumer_id = randomUUID();
    const opts = {
      consumer_id,
      scope: {
        kind: "projects",
        project_ids: [env.project.toUpperCase(), env.project],
      },
    };
    const first = await demand("acquire", opts);
    expect(first.scope).toEqual({
      kind: "projects",
      project_ids: [env.project],
    });
    expect(await demand("acquire", opts)).toEqual(first);
    expect(await demand("renew", first)).toEqual({ ...first, renewed: false });
    await expect(
      demand("acquire", { consumer_id, scope: { kind: "all" } }),
    ).rejects.toThrow(/scope conflict/);
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET renew_after=now()-interval '1 second'",
    );
    const next = await demand("renew", first);
    expect(next.renewed).toBe(true);
    expect(next.expires_at).toBeGreaterThanOrEqual(first.expires_at);
    expect((await demand("inspect")).active_consumers).toBe(1);
    expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
  });

  test("release, expiry and stale lease tokens cannot extend grace or release a replacement", async () => {
    const opts = { consumer_id: randomUUID(), scope: { kind: "all" } };
    const first = await demand("acquire", opts);
    expect(await demand("release", first)).toEqual({ released: true });
    const before = await env.sql(
      "a",
      "SELECT grace_until FROM collaboration_demand",
    );
    expect(await demand("release", first)).toEqual({ released: false });
    expect(
      await env.sql("a", "SELECT grace_until FROM collaboration_demand"),
    ).toEqual(before);
    expect((await demand("inspect")).state).toBe("grace");
    await expect(demand("renew", first)).rejects.toThrow(/expired/);
    const replacement = await demand("acquire", opts);
    expect(replacement.lease_id).not.toBe(first.lease_id);
    expect(await demand("release", first)).toEqual({ released: false });
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET expires_at=now()-interval '1 second'",
    );
    await expect(demand("renew", replacement)).rejects.toThrow(/expired/);
    expect((await demand("inspect")).state).toBe("grace");
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=now()-interval '1 second'",
    );
    expect(await demand("inspect")).toEqual({
      state: "cold",
      active_consumers: 0,
      scope: null,
    });
    expect(await demand("prune")).toBe(1);
    expect(await demand("prune")).toBe(0);
  });

  test("concurrent admissions enforce a bounded live and grace footprint", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        demand("acquire", {
          consumer_id: randomUUID(),
          scope: { kind: "all" },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(16);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(4);
    expect((await demand("inspect")).active_consumers).toBe(16);
    await expect(
      demand("acquire", {
        consumer_id: randomUUID(),
        scope: { kind: "projects", project_ids: [] },
      }),
    ).rejects.toThrow(/scope/);
  });

  test("wrong home and banned accounts cannot acquire demand", async () => {
    const opts = { consumer_id: randomUUID(), scope: { kind: "all" } };
    await env.sql("a", "UPDATE accounts SET banned=TRUE WHERE account_id=$1", [
      env.accounts[0],
    ]);
    await expect(demand("acquire", opts)).rejects.toThrow(/unavailable/);
    await env.sql(
      "a",
      "UPDATE accounts SET banned=FALSE,home_bay_id=$2 WHERE account_id=$1",
      [env.accounts[0], env.bays[2]],
    );
    await expect(demand("acquire", opts)).rejects.toThrow(/homed/);
    await env.sql(
      "a",
      "UPDATE accounts SET home_bay_id=$2 WHERE account_id=$1",
      [env.accounts[0], env.bays[1]],
    );
    expect(await env.sql("a", "SELECT * FROM collaboration_demand")).toEqual(
      [],
    );
  });

  test("overlapping scopes aggregate without granting access or sharing another account's lease", async () => {
    const extra = randomUUID();
    const first = await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [extra, env.project] },
    });
    expect(await demand("inspect")).toEqual({
      state: "active",
      active_consumers: 2,
      scope: { kind: "projects", project_ids: [extra, env.project].sort() },
    });
    expect(
      await env
        .worker("b")
        .call("demand", { operation: "release", opts: first }),
    ).toEqual({ released: false });
    expect((await demand("inspect")).active_consumers).toBe(2);
    expect(
      await env.worker("b").call("demand", { operation: "inspect" }),
    ).toEqual({ state: "cold", active_consumers: 0, scope: null });
    // A requested project ID is interest, never evidence of project membership.
    expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
  });

  test("activation is scoped, bounded and idempotent; expired demand schedules nothing", async () => {
    const others = [randomUUID(), randomUUID()];
    for (const project_id of others)
      await env.sql(
        "a",
        `INSERT INTO account_project_index
      (account_id,project_id,owning_bay_id,users_summary) VALUES($1,$2,$3,$4)`,
        [
          env.accounts[0],
          project_id,
          env.bays[0],
          JSON.stringify({ [env.accounts[0]]: { group: "collaborator" } }),
        ],
      );
    const request = {
      consumer_id: randomUUID(),
      scope: {
        kind: "projects",
        project_ids: [env.project, others[0], randomUUID()],
      },
    };
    const lease = await demand("acquire", request);
    expect(await demand("activate", { limit: 1 })).toEqual({
      scheduled: 1,
      complete: false,
    });
    const cursor = await env.sql(
      "a",
      "SELECT after_project,due_at FROM collaboration_demand_activation",
    );
    expect(await demand("acquire", request)).toEqual(lease);
    expect(
      await env.sql(
        "a",
        "SELECT after_project,due_at FROM collaboration_demand_activation",
      ),
    ).toEqual(cursor);
    await env.sql(
      "a",
      "UPDATE collaboration_demand_activation SET due_at=clock_timestamp()-interval '1 second'",
    );
    expect(await demand("activate", { limit: 1 })).toEqual({
      scheduled: 1,
      complete: true,
    });
    expect(await demand("activate", { limit: 1 })).toEqual({
      scheduled: 0,
      complete: true,
    });
    const scheduled = await env.sql(
      "a",
      "SELECT project_id,generation,lease_until FROM collaboration_access ORDER BY project_id",
    );
    expect(scheduled.map((row) => row.project_id)).toEqual(
      [env.project, others[0]].sort(),
    );
    expect(
      scheduled.every(
        (row) => row.generation === null && row.lease_until === null,
      ),
    ).toBe(true);
    await demand("release", lease);
    await demand("acquire", {
      consumer_id: request.consumer_id,
      scope: { kind: "all" },
    });
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    expect(await demand("activate", { limit: 1 })).toEqual({
      scheduled: 0,
      complete: true,
    });
    expect(
      await env.sql("a", "SELECT * FROM collaboration_demand_activation"),
    ).toEqual([]);
    expect(
      await env.sql("a", "SELECT project_id FROM collaboration_access"),
    ).toHaveLength(2);
  });

  test("activation dispatcher visits only explicitly queued accounts", async () => {
    expect(await demand("activationPass")).toEqual({
      accounts: 0,
      scheduled: 0,
    });
    const request = {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    };
    const receipt = await demand("acquire", request);
    expect(await demand("activationPass")).toEqual({
      accounts: 1,
      scheduled: 1,
    });
    expect(await demand("activationPass")).toEqual({
      accounts: 0,
      scheduled: 0,
    });
    expect(
      await env.worker("b").call("demand", { operation: "activationPass" }),
    ).toEqual({ accounts: 0, scheduled: 0 });
    await env.sql("a", "DELETE FROM collaboration_demand_activation");
    expect(await demand("acquire", request)).toEqual(receipt);
    expect(await demand("activationPass")).toEqual({
      accounts: 1,
      scheduled: 1,
    });
  });

  test("demand scheduler ignores cold and out-of-scope access rows and retires expired queues", async () => {
    await demand("enableScheduler");
    const cold = randomUUID();
    const outside = randomUUID();
    await env.sql(
      "a",
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
      [cold, env.bays[1]],
    );
    await env.sql(
      "a",
      `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
      VALUES($1,$3,now()-interval '1 day',now()-interval '1 day'),($2,$4,now()-interval '1 day',now()-interval '1 day')`,
      [cold, env.accounts[0], env.project, outside],
    );
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    await demand("activationPass");
    expect(
      (await demand("claimProjection")).map((job) => [
        job.account_id,
        job.project_id,
      ]),
    ).toEqual([[env.accounts[0], env.project]]);
    expect(
      (await demand("claimAccess")).map((job) => [
        job.account_id,
        job.project_id,
      ]),
    ).toEqual([[env.accounts[0], env.project]]);
    expect(
      await env.sql(
        "a",
        "SELECT grant_request_id FROM collaboration_access WHERE account_id=$1 OR project_id=$2",
        [cold, outside],
      ),
    ).toEqual([{ grant_request_id: null }, { grant_request_id: null }]);
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    await env.sql(
      "a",
      "UPDATE collaboration_demand_activation SET projection_due=clock_timestamp()-interval '1 second',access_due=clock_timestamp()-interval '1 second'",
    );
    await env.sql(
      "a",
      "UPDATE collaboration_access SET claim_until=NULL,lease_claim_until=NULL",
    );
    expect(await demand("claimProjection")).toEqual([]);
    expect(await demand("claimAccess")).toEqual([]);
    expect(
      await env.sql(
        "a",
        "SELECT projection_due,access_due FROM collaboration_demand_activation",
      ),
    ).toEqual([{ projection_due: null, access_due: null }]);
  });

  test("cutover maintenance makes no owner RPC or seed work for 1000 cold memberships", async () => {
    await demand("enableScheduler");
    await env.sql(
      "a",
      `INSERT INTO accounts(account_id,home_bay_id)
      SELECT md5('demand-cold-' || n)::uuid,$1 FROM generate_series(1,1000) n`,
      [env.bays[1]],
    );
    await env.sql(
      "a",
      `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
      SELECT md5('demand-cold-' || n)::uuid,$1,$2,
      jsonb_build_object((md5('demand-cold-' || n)::uuid)::text,jsonb_build_object('group','collaborator'))
      FROM generate_series(1,1000) n`,
      [env.project, env.bays[0]],
    );
    await env.sql(
      "a",
      `INSERT INTO collaboration_access(account_id,project_id,due_at,lease_due_at)
      SELECT md5('demand-cold-' || n)::uuid,$1,now()-interval '1 day',now()-interval '1 day' FROM generate_series(1,1000) n`,
      [env.project],
    );
    const before = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    await demand("maintenance");
    await demand("maintenance");
    const after = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    for (const method of ["projectPage", "refreshAccess", "notificationPage"])
      expect(after[method] ?? 0).toBe(before[method] ?? 0);
    expect(
      await env.sql(
        "a",
        "SELECT * FROM collaboration_maintenance WHERE id='seed'",
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "a",
        "SELECT grant_request_id FROM collaboration_access WHERE grant_request_id IS NOT NULL",
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "a",
        "SELECT count(*)::integer AS n FROM collaboration_access",
      ),
    ).toEqual([{ n: 1000 }]);
  }, 60000);
});
