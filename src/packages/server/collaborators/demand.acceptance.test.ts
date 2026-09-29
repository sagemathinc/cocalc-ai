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
});
