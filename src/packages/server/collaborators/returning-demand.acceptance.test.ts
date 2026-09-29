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

acceptance("return after catalog retention (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  const demand = (operation: string, opts = {}) =>
    env.worker("b").call("demand", { operation, opts });
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("expired demand resnapshots a compacted catalog without losing personal state or replaying history", async () => {
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const retained = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Retained conversation",
    });
    const removed = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Removed while away",
    });
    await env.converge(
      async () => (await env.hub("b", "listResources")).items.length === 2,
    );
    const target = {
      project_id: env.project,
      kind: "conversation",
      resource_id: retained.thread_id,
    };
    await env.hub("b", "setPersonalState", {
      ...target,
      patch: { alias: "my-kept-name", collected: true, following: true },
    });
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: retained.thread_id,
      text: "Historical message already delivered before sleep",
    });
    await env.converge(async () => {
      const resource = await env.hub("b", "getResource", target);
      const rows = await env.sql(
        "b",
        "SELECT notification_id FROM notification_targets",
      );
      return Number(resource.activity) > 0 && rows.length === 1;
    });
    const activity = (await env.hub("b", "getResource", target)).activity;
    await env.hub("b", "setPersonalState", {
      ...target,
      patch: { read_through: activity },
    });
    const personal = await env.sql(
      "b",
      "SELECT * FROM collaboration_personal WHERE account_id=$1 AND alias='my-kept-name'",
      [env.accounts[1]],
    );
    const notifications = await env.sql(
      "b",
      "SELECT notification_id FROM notification_targets ORDER BY notification_id",
    );
    const generation = (
      await env.sql("b", "SELECT generation FROM collaboration_access")
    )[0].generation;
    await demand("install");
    await demand("enableScheduler");
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    // Simulate elapsed retention time, not a six-month wall-clock soak.
    await env.sql(
      "b",
      `UPDATE collaboration_demand SET expires_at=now()-interval '6 months',
      renew_after=now()-interval '6 months',grace_until=now()-interval '6 months'`,
    );
    await demand("prune");
    expect((await demand("inspect")).state).toBe("cold");
    // Supply an aged deletion at the canonical catalog boundary. Source-file
    // deletion detection is a separate gate; compaction itself is production code.
    await env.sql(
      "owner",
      `UPDATE collaboration_catalog SET deleted_at=now()-interval '6 months'
      WHERE project_id=$1 AND resource_id=$2`,
      [env.project, removed.thread_id],
    );
    expect(await env.worker("owner").call("compactCatalog")).toBe(1);
    const ownerGeneration = (
      await env.sql("owner", "SELECT generation FROM collaboration_projects")
    )[0].generation;
    expect(ownerGeneration).not.toBe(generation);
    const before = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    await demand("maintenance");
    expect(
      (await env.worker("owner").call("inspect")).counters.ownerCalls,
    ).toEqual(before);
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    await demand("maintenance");
    const page = await env.hub("b", "listResources");
    expect(page.items.map((item) => item.resource_id)).toEqual([
      retained.thread_id,
    ]);
    expect(
      await env.sql(
        "b",
        "SELECT generation,complete FROM collaboration_access",
      ),
    ).toEqual([{ generation: ownerGeneration, complete: true }]);
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_personal WHERE account_id=$1 AND alias='my-kept-name'",
        [env.accounts[1]],
      ),
    ).toEqual(personal);
    expect(
      await env.sql(
        "b",
        "SELECT notification_id FROM notification_targets ORDER BY notification_id",
      ),
    ).toEqual(notifications);
    await env.sql(
      "b",
      "UPDATE collaboration_demand SET grace_until=now()-interval '6 months',expires_at=now()-interval '6 months'",
    );
    await demand("prune");
    await env.worker("owner").call("membership", { group: "viewer" });
    await demand("acquire", {
      consumer_id: randomUUID(),
      scope: { kind: "projects", project_ids: [env.project] },
    });
    await demand("maintenance");
    expect((await env.hub("b", "listResources")).items).toEqual([]);
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_personal WHERE account_id=$1 AND alias='my-kept-name'",
        [env.accounts[1]],
      ),
    ).toEqual(personal);
    expect((await env.worker("owner").call("inspect")).counters.starts).toBe(0);
  }, 90000);
});
