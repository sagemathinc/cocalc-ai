/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash, randomUUID } from "node:crypto";
import { MultibayAcceptance } from "./acceptance/harness";

const acceptance =
  process.env.COCALC_COLLABORATORS_ACCEPTANCE === "1"
    ? describe
    : describe.skip;
acceptance("event-driven notification scheduling (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);
  test("ingestion schedules owner work, delivers to a cold home, and clears the idle marker", async () => {
    const tick = () =>
      env.worker("owner").call("notificationFanout", { operation: "tick" });
    expect(await tick()).toBe(0);
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Scheduled notification",
    });
    const key = createHash("sha256")
      .update(JSON.stringify([env.project, "conversation", thread.thread_id]))
      .digest("hex");
    await env.sql(
      "b",
      `INSERT INTO collaboration_personal(account_id,entry_key,project_id,following,following_explicit)
      VALUES($1,$2,$3,true,true)`,
      [env.accounts[1], key, env.project],
    );
    // Model the owner routing hint installed before the home Follow commits.
    await env.sql(
      "owner",
      "INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id) VALUES($1,$2,$3,$4)",
      [randomUUID(), env.project, key, env.accounts[1]],
    );
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Event-driven delivery",
    });
    let count = 0;
    let checkedDisabled = false;
    for (let i = 0; i < 40 && !count; i++) {
      await env.worker("host").call("tick");
      if (
        !checkedDisabled &&
        (
          await env.sql(
            "owner",
            "SELECT project_id FROM collaboration_projects WHERE notification_due IS NOT NULL",
          )
        ).length
      ) {
        await env
          .worker("owner")
          .call("setCollaboratorsEnabled", { enabled: false });
        expect(await tick()).toBe(0);
        expect(
          await env.sql(
            "b",
            "SELECT notification_id FROM notification_targets",
          ),
        ).toHaveLength(0);
        await env
          .worker("owner")
          .call("setCollaboratorsEnabled", { enabled: true });
        checkedDisabled = true;
      }
      await tick();
      count = Number(
        (
          await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
        )[0].n,
      );
      if (!count) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(count).toBe(1);
    expect(checkedDisabled).toBe(true);
    expect(await env.sql("b", "SELECT * FROM collaboration_index")).toEqual([]);
    expect(
      await env.sql(
        "owner",
        "SELECT * FROM collaboration_notification_recipients",
      ),
    ).toEqual([]);
    expect(
      await env.sql(
        "owner",
        "SELECT notification_due,notification_claim FROM collaboration_projects WHERE project_id=$1",
        [env.project],
      ),
    ).toEqual([{ notification_due: null, notification_claim: null }]);
    expect(await tick()).toBe(0);
    expect(
      await env.sql(
        "b",
        "SELECT lease_until,generation FROM collaboration_access",
      ),
    ).toEqual([{ lease_until: null, generation: null }]);
    expect(
      await env.sql("b", "SELECT notification_id FROM notification_targets"),
    ).toHaveLength(1);
  }, 60000);
});
