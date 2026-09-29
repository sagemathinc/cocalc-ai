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
    await env.worker("owner").call("installRevisionInterest");
    await env.worker("a").call("installRevisionReceiver");
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  beforeEach(async () => {
    await env.sql("a", "DELETE FROM collaboration_demand");
    await env.sql("a", "DELETE FROM collaboration_demand_activation");
    await env.sql("a", "DELETE FROM collaboration_access");
  });

  test("revision registration crosses the fabric and derives demand from the actual home", async () => {
    const invoke = () => env.worker("b").call("registerRevisionInterest");
    await expect(invoke()).rejects.toThrow("no home demand");
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    const first = await invoke();
    expect(await invoke()).toEqual({
      ...first,
      remaining_ms: expect.any(Number),
    });
    expect(
      await env.sql(
        "owner",
        "SELECT home_bay_id,lease_id FROM collaboration_revision_interests WHERE project_id=$1",
        [env.project],
      ),
    ).toEqual([{ home_bay_id: env.bays[1], lease_id: first.lease_id }]);
    const [{ users }] = await env.sql(
      "owner",
      "SELECT users FROM projects WHERE project_id=$1",
      [env.project],
    );
    try {
      await env.sql(
        "owner",
        "UPDATE projects SET users=users-$2 WHERE project_id=$1",
        [env.project, env.accounts[0]],
      );
      await expect(invoke()).rejects.toThrow("access denied");
    } finally {
      await env.sql(
        "owner",
        "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
        [env.project, JSON.stringify(users)],
      );
    }
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    await expect(invoke()).rejects.toThrow("no home demand");
    expect(
      await env.sql(
        "owner",
        "SELECT lease_id FROM collaboration_revision_interests WHERE project_id=$1",
        [env.project],
      ),
    ).toEqual([{ lease_id: first.lease_id }]);
  }, 60000);
  test("owner interest is bounded by relevant demand, not another project's longer horizon", async () => {
    await env.sql(
      "owner",
      "DELETE FROM collaboration_revision_interests WHERE project_id=$1",
      [env.project],
    );
    const invoke = () => env.worker("b").call("registerRevisionInterest");
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [randomUUID()] },
    });
    await expect(invoke()).rejects.toThrow("no home demand");
    const consumer_id = randomUUID();
    await demand("acquire", {
      consumer_id,
      scope: { kind: "projects", project_ids: [env.project] },
    });
    const [row] = await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()+interval '10 seconds' WHERE consumer_id=$1 RETURNING grace_until",
      [consumer_id],
    );
    const interest = await invoke();
    expect(interest.expires_at).toBeLessThanOrEqual(
      new Date(row.grace_until).getTime(),
    );
    expect(interest.expires_at).toBeGreaterThan(Date.now());
  }, 60000);
  test("revision dispatch durably wakes the registered home before acknowledging", async () => {
    await expect(
      env.worker("b").call("registerRevisionReceiver"),
    ).rejects.toThrow("no home demand");
    await env.sql(
      "owner",
      "DELETE FROM collaboration_revision_interests WHERE project_id=$1",
      [env.project],
    );
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "all" },
    });
    const lease = await env.worker("b").call("registerRevisionInterest");
    await env.sql(
      "owner",
      `INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,1)
      ON CONFLICT(project_id) DO UPDATE SET revision=collaboration_projects.revision+1`,
      [env.project, randomUUID()],
    );
    const request = {
      project_id: env.project,
      home_bay_id: env.bays[1],
      lease_id: lease.lease_id,
    };
    expect(
      await env.worker("owner").call("dispatchRevisionHint", request),
    ).toEqual({ state: "deferred" });
    const [unacked] = await env.sql(
      "owner",
      "SELECT ack_generation FROM collaboration_revision_interests WHERE project_id=$1",
      [env.project],
    );
    expect(unacked.ack_generation).toBeNull();
    expect(await env.worker("b").call("registerRevisionReceiver")).toEqual({
      armed: true,
      lease_id: lease.lease_id,
    });
    expect(await env.worker("b").call("registerRevisionReceiver")).toEqual({
      armed: true,
      lease_id: lease.lease_id,
    });
    await env.sql(
      "owner",
      "UPDATE collaboration_revision_interests SET delivery_until=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [env.project],
    );
    expect(
      await env.worker("owner").call("dispatchRevisionHint", request),
    ).toEqual({ state: "acknowledged" });
    const [received] = await env.sql(
      "a",
      "SELECT dirty_seq::text,applied_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
      [env.project],
    );
    expect(received).toEqual({ dirty_seq: "2", applied_seq: "0" });
    expect(
      await env.worker("owner").call("dispatchRevisionHint", request),
    ).toEqual({ state: "deferred" });
  }, 60000);
  test("repair delivers changed watermarks through the fabric and ignores acknowledged or expired interests", async () => {
    await env.sql(
      "owner",
      "DELETE FROM collaboration_revision_interests WHERE project_id=$1",
      [env.project],
    );
    await env.sql(
      "a",
      "DELETE FROM collaboration_revision_receivers WHERE project_id=$1",
      [env.project],
    );
    await env.sql(
      "owner",
      `INSERT INTO collaboration_projects(project_id,generation,revision) VALUES($1,$2,1)
      ON CONFLICT(project_id) DO NOTHING`,
      [env.project, randomUUID()],
    );
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "all" },
    });
    await demand("membershipFeed");
    await demand("activate");
    const jobs = await env.worker("a").call("claimActiveProjection");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].project_id).toBe(env.project);
    await env.worker("b").call("registerRevisionReceiver");
    const [before] = await env.sql(
      "a",
      "SELECT dirty_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
      [env.project],
    );
    await env.sql(
      "owner",
      "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1",
      [env.project],
    );
    expect(await env.worker("owner").call("repairRevisionHints")).toBe(1);
    const [ack] = await env.sql(
      "owner",
      `SELECT i.ack_generation=c.generation AND i.ack_revision=c.revision AS current
      FROM collaboration_revision_interests i JOIN collaboration_projects c USING(project_id)
      WHERE i.project_id=$1`,
      [env.project],
    );
    expect(ack.current).toBe(true);
    const read = () =>
      env.sql(
        "a",
        "SELECT dirty_seq::text,applied_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
        [env.project],
      );
    const expected = [
      { dirty_seq: String(BigInt(before.dirty_seq) + 1n), applied_seq: "0" },
    ];
    expect(await read()).toEqual(expected);
    expect(await env.worker("a").call("scheduleRevisionWakeups")).toBe(0);
    const scheduling = () =>
      env.sql(
        "a",
        "SELECT scheduling_complete,applied_seq::text FROM collaboration_revision_receivers WHERE project_id=$1",
        [env.project],
      );
    expect(await scheduling()).toEqual([
      { scheduling_complete: false, applied_seq: "0" },
    ]);
    await env.sql(
      "a",
      `UPDATE collaboration_access SET claim_until=clock_timestamp()-interval '1 second',
      due_at=clock_timestamp()+interval '1 day' WHERE account_id=$1 AND project_id=$2`,
      [env.accounts[0], env.project],
    );
    let scheduled = 0;
    // The bounded project cursor may need a wrap pass before revisiting this row.
    for (let i = 0; i < 3; i++)
      scheduled += await env.worker("a").call("scheduleRevisionWakeups");
    expect(scheduled).toBe(1);
    expect(await scheduling()).toEqual([
      { scheduling_complete: true, applied_seq: "0" },
    ]);
    expect(
      await env.sql(
        "a",
        "SELECT due_at<=clock_timestamp() AS due FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
        [env.accounts[0], env.project],
      ),
    ).toEqual([{ due: true }]);
    expect(await env.worker("owner").call("repairRevisionHints")).toBe(0);
    expect(await read()).toEqual(expected);
    await env.sql(
      "owner",
      "UPDATE collaboration_revision_interests SET expires_at=clock_timestamp()-interval '1 second' WHERE project_id=$1",
      [env.project],
    );
    await env.sql(
      "owner",
      "UPDATE collaboration_projects SET revision=revision+1 WHERE project_id=$1",
      [env.project],
    );
    expect(await env.worker("owner").call("repairRevisionHints")).toBe(0);
    expect(await read()).toEqual(expected);
  }, 60000);
  test("shared catalog transport rejects cold and cross-home batches", async () => {
    await expect(env.worker("a").call("sharedProjectPage")).rejects.toThrow(
      "no demand",
    );
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "all" },
    });
    const page = await env.worker("a").call("sharedProjectPage");
    expect(page.catalog).not.toBeNull();
    expect(page.recipients).toHaveLength(1);
    expect(page.recipients[0]).toMatchObject({
      account_id: env.accounts[0],
      allowed: true,
    });
    expect(page.catalog).not.toHaveProperty("attention_generation");
    await expect(
      env.worker("a").call("sharedProjectPage", { account_ids: env.accounts }),
    ).rejects.toThrow("home mismatch");
  }, 60000);
  test("authenticated demand calls bind the caller and cannot release another account's lease", async () => {
    expect((await env.hub("a", "check", {})).demand_supported).toBeUndefined();
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

  test("grace does not consume live slots and old IDs cannot bypass the live cap", async () => {
    const retired = await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "all" },
    });
    await demand("release", retired);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, () =>
        demand("acquire", {
          consumer_id: randomUUID(),
          scope: { kind: "all" },
        }),
      ),
    );
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect((await demand("inspect")).active_consumers).toBe(16);
    await expect(
      demand("acquire", {
        consumer_id: retired.consumer_id,
        scope: { kind: "all" },
      }),
    ).rejects.toThrow("live consumer capacity");
    const live = results[0];
    if (live.status !== "fulfilled") throw Error("expected live consumer");
    await demand("release", live.value);
    const replacement = await demand("acquire", {
      consumer_id: retired.consumer_id,
      scope: { kind: "all" },
    });
    expect(replacement.lease_id).not.toBe(retired.lease_id);
    expect((await demand("inspect")).active_consumers).toBe(16);
  });

  test("retained grace has a separate churn bound without dropping scopes", async () => {
    await env.sql(
      "a",
      `INSERT INTO collaboration_demand(account_id,consumer_id,lease_id,scope,expires_at,renew_after,grace_until,released)
      SELECT $1,md5(n::text)::uuid,md5(('lease-'||n)::text)::uuid,'{"kind":"all"}'::jsonb,
      clock_timestamp()-interval '1 second',clock_timestamp(),clock_timestamp()+interval '5 minutes',TRUE
      FROM generate_series(1,256) AS n`,
      [env.accounts[0]],
    );
    await expect(
      demand("acquire", { consumer_id: randomUUID(), scope: { kind: "all" } }),
    ).rejects.toThrow("retained consumer capacity");
    expect((await demand("inspect")).state).toBe("grace");
    const [row] = await env.sql(
      "a",
      "SELECT consumer_id FROM collaboration_demand ORDER BY consumer_id LIMIT 1",
    );
    await demand("acquire", {
      consumer_id: row.consumer_id,
      scope: { kind: "all" },
    });
    expect((await demand("inspect")).active_consumers).toBe(1);
    const [count] = await env.sql(
      "a",
      "SELECT count(*)::integer AS n FROM collaboration_demand",
    );
    expect(count.n).toBe(256);
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

  test("membership feeds wake only the affected demanded project without granting access", async () => {
    await demand("enableScheduler");
    expect((await env.hub("a", "check", {})).demand_supported).toBe(true);
    const joined = randomUUID();
    const outside = randomUUID();
    const consumer_id = randomUUID();
    await demand("acquire", {
      consumer_id,
      scope: { kind: "projects", project_ids: [joined] },
    });
    expect(await demand("activate")).toEqual({ scheduled: 0, complete: true });
    await demand("membershipFeed", { project_id: outside });
    await demand("membershipFeed", { project_id: joined, group: "viewer" });
    expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
    await demand("membershipFeed", { project_id: joined });
    await demand("membershipFeed", { project_id: joined });
    expect(
      await env.sql(
        "a",
        "SELECT project_id,grant_request_id,granted_generation FROM collaboration_access",
      ),
    ).toEqual([
      { project_id: joined, grant_request_id: null, granted_generation: null },
    ]);
    // No restart of global activation, even after duplicate feed delivery.
    expect(
      await env.sql("a", "SELECT due_at FROM collaboration_demand_activation"),
    ).toEqual([{ due_at: null }]);
    expect(
      (await demand("claimProjection")).map((row) => row.project_id),
    ).toEqual([joined]);
    await env.sql("a", "DELETE FROM collaboration_access");
    await env.sql("a", "DELETE FROM collaboration_demand_activation");
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    await demand("membershipFeed", { project_id: joined });
    expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
    expect(
      await env.sql("a", "SELECT * FROM collaboration_demand_activation"),
    ).toEqual([]);
  });

  test("membership and scheduling roll back together if the targeted job write fails", async () => {
    await demand("enableScheduler");
    const joined = randomUUID();
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [joined] },
    });
    const before = await env.sql(
      "a",
      "SELECT * FROM collaboration_demand_activation",
    );
    // Inject a storage failure in the isolated fixture, after the feed upsert
    // and account queue update but before the access job can be committed.
    await env.sql(
      "a",
      `ALTER TABLE collaboration_access ADD CONSTRAINT fixture_reject_membership_job CHECK(project_id <> '${joined}'::uuid) NOT VALID`,
    );
    try {
      await expect(
        demand("membershipFeed", { project_id: joined }),
      ).rejects.toThrow(/fixture_reject_membership_job/);
      expect(
        await env.sql(
          "a",
          "SELECT project_id FROM account_project_index WHERE project_id=$1",
          [joined],
        ),
      ).toEqual([]);
      expect(
        await env.sql("a", "SELECT * FROM collaboration_demand_activation"),
      ).toEqual(before);
      expect(await env.sql("a", "SELECT * FROM collaboration_access")).toEqual(
        [],
      );
    } finally {
      await env.sql(
        "a",
        "ALTER TABLE collaboration_access DROP CONSTRAINT fixture_reject_membership_job",
      );
    }
    await demand("membershipFeed", { project_id: joined });
    expect(
      await env.sql("a", "SELECT project_id FROM collaboration_access"),
    ).toEqual([{ project_id: joined }]);
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
    const firstPage = await env.sql(
      "a",
      "SELECT account_id,project_id FROM collaboration_access ORDER BY account_id,project_id LIMIT 20",
    );
    await demand("maintenance");
    const cleanup = (
      await env.sql(
        "a",
        "SELECT cursor FROM collaboration_maintenance WHERE id='cleanup'",
      )
    )[0].cursor;
    expect(cleanup.account_id).toBe(firstPage.at(-1)!.account_id);
    expect(cleanup.project_id).toBe(firstPage.at(-1)!.project_id);
    await demand("maintenance");
    expect(
      (
        await env.sql(
          "a",
          "SELECT cursor FROM collaboration_maintenance WHERE id='cleanup'",
        )
      )[0].cursor,
    ).toEqual(cleanup);
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
