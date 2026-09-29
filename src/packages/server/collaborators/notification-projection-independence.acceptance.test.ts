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
acceptance("notification delivery without a conversation projection", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("a live reply reaches an offline follower without rebuilding their resource index", async () => {
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Offline follower",
    });
    await env.converge(
      async () => (await env.hub("b", "listResources")).items.length === 1,
    );
    await env.hub("b", "setPersonalState", {
      project_id: env.project,
      kind: "conversation",
      resource_id: thread.thread_id,
      patch: { following: true },
    });
    await env.worker("b").call("notificationTick");
    await env.sql("b", "DELETE FROM collaboration_index WHERE account_id=$1", [
      env.accounts[1],
    ]);
    const before = Number(
      (await env.sql("b", "SELECT count(*) AS n FROM notification_targets"))[0]
        .n,
    );
    await env.send("a", "send", {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Reply while the view is cold",
    });
    const deadline = Date.now() + 20000;
    let after = before;
    while (Date.now() < deadline && after === before) {
      await env.worker("host").call("tick");
      await env.worker("b").call("notificationTick");
      after = Number(
        (
          await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
        )[0].n,
      );
      if (after === before)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(after).toBe(before + 1);
    expect(await env.sql("b", "SELECT * FROM collaboration_index")).toEqual([]);
    expect(
      (
        await env.sql(
          "b",
          "SELECT following FROM collaboration_personal WHERE account_id=$1",
          [env.accounts[1]],
        )
      )[0].following,
    ).toBe(true);
    await env.worker("b").call("notificationTick");
    expect(
      Number(
        (
          await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
        )[0].n,
      ),
    ).toBe(after);
  }, 60000);
});
