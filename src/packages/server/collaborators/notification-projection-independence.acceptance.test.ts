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
    await env.worker("owner").call("notificationFanout", { operation: "tick" });
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
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "tick" });
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
    await env.worker("owner").call("notificationFanout", { operation: "tick" });
    expect(
      Number(
        (
          await env.sql("b", "SELECT count(*) AS n FROM notification_targets")
        )[0].n,
      ),
    ).toBe(after);
  }, 60000);
});

acceptance("offline notification recovery across account rehome", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("expired demand, a lost acknowledgment and worker loss retain exactly one effect per event at the new home", async () => {
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Offline recovery",
    });
    await env.converge(
      async () => (await env.hub("a", "listResources")).items.length === 1,
    );
    await env.hub("a", "setPersonalState", {
      project_id: env.project,
      kind: "conversation",
      resource_id: thread.thread_id,
      patch: { following: true },
    });
    await env.sql(
      "a",
      "UPDATE collaboration_demand SET expires_at=now()-interval '10 minutes',grace_until=now()-interval '5 minutes'",
    );
    await env.sql(
      "a",
      "UPDATE collaboration_access SET lease_until=now()-interval '1 minute'",
    );
    await env.sql("a", "DELETE FROM collaboration_index");
    const count = async (role: "a" | "b") =>
      Number(
        (
          await env.sql(
            role,
            "SELECT count(*) AS n FROM notification_targets WHERE target_account_id=$1",
            [env.accounts[0]],
          )
        )[0].n,
      );
    const before = await count("a");
    const sendAndExpand = async (text: string, expected: number) => {
      await env.retrySend("b", "send", {
        request_id: randomUUID(),
        thread_id: thread.thread_id,
        text,
      });
      let events: any[] = [];
      for (let i = 0; i < 40; i++) {
        await env.worker("host").call("tick");
        events = await env.sql(
          "owner",
          "SELECT event_id FROM collaboration_notification_events ORDER BY position",
        );
        if (events.length === expected) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(events).toHaveLength(expected);
      for (const event of events)
        await env
          .worker("owner")
          .call("notificationFanout", { event_id: event.event_id });
    };
    await sendAndExpand("Committed before the reply was lost", 1);
    const processor = await env.restartOwnerProcessor();
    const lost = await processor.call("notificationFanout", {
      operation: "drain",
      lose_reply: true,
    });
    expect(lost).toMatchObject({ attempted: 1, acknowledged: 0, deferred: 1 });
    expect(await count("a")).toBe(before + 1);
    await sendAndExpand("Still pending when the account moves", 2);
    expect(
      await env.sql(
        "owner",
        "SELECT id FROM collaboration_notification_recipients",
      ),
    ).toHaveLength(2);

    const moved = await env.worker("owner").call("accountRehome", {
      source_bay_id: env.bays[1],
      dest_bay_id: env.bays[2],
    });
    expect(moved.status).toBe("rehomed");
    const resumed = await env.restartOwnerProcessor();
    await env.sql(
      "owner",
      "UPDATE collaboration_notification_recipients SET due_at=now()",
    );
    expect(
      await resumed.call("notificationFanout", { operation: "drain" }),
    ).toMatchObject({ attempted: 2, acknowledged: 2, deferred: 0 });
    expect(await count("b")).toBe(before + 2);
    expect(
      await env.sql(
        "owner",
        "SELECT id FROM collaboration_notification_recipients",
      ),
    ).toEqual([]);
    await resumed.call("notificationFanout", { operation: "drain" });
    expect(await count("b")).toBe(before + 2);
    expect(
      await env.sql(
        "b",
        "SELECT * FROM collaboration_index WHERE account_id=$1",
        [env.accounts[0]],
      ),
    ).toEqual([]);
    for (const role of ["owner", "a", "b"] as const)
      expect((await env.worker(role).call("inspect")).counters.starts).toBe(0);
  }, 120000);
});
