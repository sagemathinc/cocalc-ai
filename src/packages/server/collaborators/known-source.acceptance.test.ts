/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;

acceptance("known-source initial release over real fabric", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
    for (const role of ["owner", "a", "b"] as const)
      await env.worker(role).call("installScan");
  }, 240000);
  afterAll(async () => env?.close(), 60000);

  test("timers refresh an active view and notify a cold recipient without discovering unknown files", async () => {
    const unknown = await env.worker("host").call("explicitCensusFixture");
    await env.sql(
      "a",
      `INSERT INTO accounts(account_id,home_bay_id)
       SELECT md5('known-source-cold-' || n)::uuid,$1 FROM generate_series(1,1000) n`,
      [env.bays[1]],
    );
    await env.sql(
      "a",
      `INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary)
       SELECT md5('known-source-cold-' || n)::uuid,$1,$2,
       jsonb_build_object((md5('known-source-cold-' || n)::uuid)::text,
         jsonb_build_object('group','collaborator'))
       FROM generate_series(1,1000) n`,
      [env.project, env.bays[0]],
    );
    // Select demand, fanout and revision delivery together, but never enable
    // demand-triggered filesystem discovery. No manual maintenance ticks below.
    for (const role of ["owner", "a", "b"] as const)
      await env.worker(role).call("startRevisionMaintenance");
    const consumer_id = randomUUID();
    const demand = await env.hub("a", "acquireDemand", {
      consumer_id,
      scope: { kind: "projects", project_ids: [env.project] },
    });
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const threads: string[] = [];
    for (let i = 0; i < 8; i++) {
      const thread = await env.send("a", "createThread", {
        request_id: randomUUID(),
        title: `Known source ${i}`,
      });
      threads.push(thread.thread_id);
    }
    const key = createHash("sha256")
      .update(JSON.stringify([env.project, "conversation", threads[0]]))
      .digest("hex");
    await env.sql(
      "b",
      `INSERT INTO collaboration_personal(account_id,entry_key,project_id,following,following_explicit)
       VALUES($1,$2,$3,true,true)`,
      [env.accounts[1], key, env.project],
    );
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: threads[0],
      text: "Deliver even while the recipient has no People demand",
    });
    const deadline = Date.now() + 30000;
    let complete = false;
    while (Date.now() < deadline) {
      const page = await env.hub("a", "listResources", {
        project_id: env.project,
      });
      expect(
        page.items.some(
          (item: CollaborationResource) => item.chat_path === unknown.chat_path,
        ),
      ).toBe(false);
      const notifications = await env.sql(
        "b",
        "SELECT notification_id FROM notification_targets",
      );
      if (
        threads.every((id) =>
          page.items.some(
            (item: CollaborationResource) => item.resource_id === id,
          ),
        ) &&
        notifications.length === 1
      ) {
        complete = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(complete).toBe(true);
    expect(await env.sql("b", "SELECT * FROM collaboration_index")).toEqual([]);
    expect(await env.sql("b", "SELECT * FROM collaboration_demand")).toEqual(
      [],
    );
    expect(
      await env.sql("owner", "SELECT job_id FROM collaboration_scan_jobs"),
    ).toEqual([]);
    expect(
      await env.sql(
        "owner",
        "SELECT request_id FROM collaboration_scan_receipts",
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "a",
        "SELECT DISTINCT account_id FROM collaboration_access",
      ),
    ).toEqual([{ account_id: env.accounts[0] }]);
    const delivered = await env.sql(
      "b",
      "SELECT notification_id FROM notification_targets ORDER BY notification_id",
    );
    await env.hub("a", "releaseDemand", {
      consumer_id,
      lease_id: demand.lease_id,
    });
    // Advance only the grace horizon; workers still run on their real timers.
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET grace_until=clock_timestamp()-interval '1 second'",
    );
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const beforeIdle = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    // Span several legacy 20-second projection cycles, not just a quiet gap
    // between timer passes. Keep the production maintenance timers running.
    const idleStarted = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 60000));
    const afterIdle = (await env.worker("owner").call("inspect")).counters
      .ownerCalls;
    process.stdout.write(
      JSON.stringify({
        workload: "known-source-demand-expired",
        observed_ms: Date.now() - idleStarted,
        calls: Object.fromEntries(
          Object.keys(afterIdle).map((method) => [
            method,
            afterIdle[method] - (beforeIdle[method] ?? 0),
          ]),
        ),
      }) + "\n",
    );
    for (const method of [
      "projectPage",
      "sharedProjectPage",
      "refreshAccess",
      "notificationPage",
    ])
      expect(afterIdle[method] ?? 0).toBe(beforeIdle[method] ?? 0);
    expect(
      await env.sql(
        "b",
        "SELECT notification_id FROM notification_targets ORDER BY notification_id",
      ),
    ).toEqual(delivered);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 180000);
});
