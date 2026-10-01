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

acceptance("disposable demand across account rehome", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    for (const role of ["a", "b"] as const) {
      await env.worker(role).call("demand", { operation: "install" });
    }
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("old-home leases are neither transferred nor renewable; the consumer reacquires at its new home", async () => {
    const opts = {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    };
    const lease = await env.hub("a", "acquireDemand", opts);
    const result = await env.worker("owner").call("accountRehome", {
      source_bay_id: env.bays[1],
      dest_bay_id: env.bays[2],
    });
    expect(result).toMatchObject({
      status: "rehomed",
      home_bay_id: env.bays[2],
    });
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_demand WHERE account_id=$1",
        [env.accounts[0]],
      ),
    ).toEqual([]);
    await expect(
      env.worker("a").call("demand", { operation: "renew", opts: lease }),
    ).rejects.toThrow(/home|rehome|authority/i);
    await expect(env.hub("a", "renewDemand", lease)).rejects.toThrow(
      /expired|unknown|lease/i,
    );
    const before = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    await env.worker("a").call("demand", { operation: "maintenance" });
    expect(
      (await env.worker("owner").call("inspect")).counters.ownerCalls,
    ).toEqual(before);
    const replacement = await env.hub("a", "acquireDemand", opts);
    expect(replacement.consumer_id).toBe(lease.consumer_id);
    expect(replacement.lease_id).not.toBe(lease.lease_id);
    expect(
      await env.sql(
        "b",
        "SELECT lease_id FROM collaboration_demand WHERE account_id=$1",
        [env.accounts[0]],
      ),
    ).toEqual([{ lease_id: replacement.lease_id }]);
    expect(await env.hub("a", "releaseDemand", lease)).toEqual({
      released: false,
    });
    expect((await env.hub("a", "inspectDemand")).active_consumers).toBe(1);
    expect((await env.worker("owner").call("inspect")).counters.starts).toBe(0);
  }, 90000);
});
