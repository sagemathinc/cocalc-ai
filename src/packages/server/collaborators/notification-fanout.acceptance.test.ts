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
acceptance("durable owner notification fanout (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("live ingestion captures work atomically and retention holds unexpanded and undelivered events", async () => {
    await env
      .worker("owner")
      .call("notificationFanout", { operation: "enable" });
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Durable fanout",
    });
    const request = {
      request_id: randomUUID(),
      thread_id: thread.thread_id,
      text: "Retain until accounted for",
    };
    await env.send("a", "send", request);
    let events: any[] = [];
    for (let i = 0; i < 30 && !events.length; i++) {
      await env.worker("host").call("tick");
      events = await env.sql(
        "owner",
        "SELECT * FROM collaboration_notification_events WHERE project_id=$1",
        [env.project],
      );
      if (!events.length)
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(events).toHaveLength(1);
    expect(events[0].fanout_pending).toBe(true);
    const event_id = events[0].event_id;
    await env.sql(
      "owner",
      "UPDATE collaboration_notification_events SET created_at=now()-interval '90 days' WHERE event_id=$1",
      [event_id],
    );
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "prune" }),
    ).toBe(0);
    await expect(
      env
        .worker("owner")
        .call("notificationFanout", { event_id, bay_id: "wrong-owner" }),
    ).rejects.toThrow(/owner unavailable/);
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { event_id, limit: 1 }),
    ).toEqual({ state: "complete", added: 1 });
    const obligations = await env.sql(
      "owner",
      "SELECT * FROM collaboration_notification_recipients WHERE event_id=$1",
      [event_id],
    );
    expect(obligations).toHaveLength(1);
    expect(obligations[0].account_id).toBe(env.accounts[1]);
    expect(obligations[0].membership_epoch).toBe(
      (
        await env.sql(
          "owner",
          "SELECT epoch FROM collaboration_memberships WHERE project_id=$1 AND account_id=$2",
          [env.project, env.accounts[1]],
        )
      )[0].epoch,
    );
    expect(
      await env.worker("owner").call("notificationFanout", { event_id }),
    ).toEqual({ state: "complete", added: 0 });
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "prune" }),
    ).toBe(0);
    expect(await env.sql("b", "SELECT * FROM collaboration_access")).toEqual(
      [],
    );
    expect(await env.sql("b", "SELECT * FROM collaboration_index")).toEqual([]);
    await env.send("a", "send", request);
    await env.worker("host").call("tick");
    expect(
      await env.sql(
        "owner",
        "SELECT id FROM collaboration_notification_recipients",
      ),
    ).toHaveLength(1);
    // Simulate successful handoff only in the owned fixture. The production
    // receiver/claim acknowledgement protocol is not enabled yet.
    await env.sql(
      "owner",
      "DELETE FROM collaboration_notification_recipients WHERE event_id=$1",
      [event_id],
    );
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "prune" }),
    ).toBe(1);
  }, 60000);

  test("recipient pagination is durable and excludes joins after the event", async () => {
    const existing = [randomUUID(), randomUUID(), randomUUID()];
    await env.sql(
      "owner",
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [
        env.project,
        JSON.stringify(
          Object.fromEntries(
            existing.map((id) => [id, { group: "collaborator" }]),
          ),
        ),
      ],
    );
    const event_id = randomUUID();
    const room = (
      await env.sql(
        "owner",
        "SELECT room_id FROM collaboration_rooms WHERE project_id=$1",
        [env.project],
      )
    )[0];
    const resource = (
      await env.sql(
        "owner",
        "SELECT metadata FROM collaboration_catalog WHERE project_id=$1 AND kind='conversation' AND deleted_at IS NULL LIMIT 1",
        [env.project],
      )
    )[0].metadata;
    // Synthetic immutable fact for the paging seam, after the first test has
    // exercised actual journal ingestion. Source bytes are not edited here.
    const fact = {
      version: 1,
      project_id: env.project,
      room_id: room.room_id,
      thread_id: resource.thread_id,
      message_id: randomUUID(),
      actor_account_id: env.accounts[0],
      activity: 2,
      mode: "live",
      mentioned_account_ids: [],
      mention_all: true,
    };
    await env.sql(
      "owner",
      `INSERT INTO collaboration_notification_events
      (event_id,project_id,generation,position,event_json,event_hash,fanout_pending,fanout_due)
      SELECT $1,project_id,generation,2,$3,'fixture',TRUE,now() FROM collaboration_projects WHERE project_id=$2`,
      [event_id, env.project, JSON.stringify(fact)],
    );
    const late = randomUUID();
    await env.sql(
      "owner",
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [env.project, JSON.stringify({ [late]: { group: "collaborator" } })],
    );
    const page = () =>
      env.worker("owner").call("notificationFanout", { event_id, limit: 2 });
    expect(await page()).toEqual({ state: "pending", added: 2 });
    expect(await page()).toEqual({ state: "complete", added: 2 });
    expect(await page()).toEqual({ state: "complete", added: 0 });
    const recipients = await env.sql(
      "owner",
      "SELECT account_id FROM collaboration_notification_recipients WHERE event_id=$1",
      [event_id],
    );
    expect(recipients.map((row) => row.account_id).sort()).toEqual(
      [env.accounts[1], ...existing].sort(),
    );
    expect(recipients.some((row) => row.account_id === late)).toBe(false);
  });

  test("bounded claims recover worker loss and reject expired or superseded acknowledgments", async () => {
    const call = (args: object) =>
      env.worker("owner").call("notificationFanout", args);
    const claim = () => call({ operation: "claim", limit: 2 });
    const settle = (row: any, outcome = "acknowledge") =>
      call({
        operation: "settle",
        id: row.id,
        claim_id: row.claim_id,
        outcome,
      });
    await expect(call({ operation: "claim", limit: 26 })).rejects.toThrow(
      /limit/,
    );
    await expect(
      call({ operation: "claim", bay_id: "wrong-owner" }),
    ).rejects.toThrow(/owner unavailable/);
    const [first, second] = await Promise.all([claim(), claim()]);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((row) => row.id)).size).toBe(4);
    expect(await claim()).toEqual([]);
    // Simulate a crashed worker's lease expiring, not an actual home receipt.
    await env.sql(
      "owner",
      "UPDATE collaboration_notification_recipients SET claim_until=clock_timestamp()-interval '1 second',due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first[0].id],
    );
    expect(await settle(first[0])).toBe(false);
    const reclaimed = await claim();
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].id).toBe(first[0].id);
    expect(reclaimed[0].claim_id).not.toBe(first[0].claim_id);
    expect(await settle(first[0])).toBe(false);
    await expect(
      call({
        operation: "settle",
        ...reclaimed[0],
        bay_id: "wrong-owner",
        outcome: "acknowledge",
      }),
    ).rejects.toThrow(/owner unavailable/);
    expect(await settle(reclaimed[0], "retry")).toBe(true);
    expect(await settle(reclaimed[0])).toBe(false);
    expect(await claim()).toEqual([]);
    await env.sql(
      "owner",
      "UPDATE collaboration_notification_recipients SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [reclaimed[0].id],
    );
    const retry = await claim();
    expect(retry).toHaveLength(1);
    expect(retry[0].event).toEqual(reclaimed[0].event);
    expect(retry[0].membership_epoch).toBe(reclaimed[0].membership_epoch);
    await env.sql(
      "owner",
      `CREATE TABLE IF NOT EXISTS project_rehome_operations(
      op_id UUID PRIMARY KEY,project_id UUID,source_bay_id TEXT,dest_bay_id TEXT,
      status TEXT,stage TEXT,created_at TIMESTAMPTZ DEFAULT now())`,
    );
    const operation = randomUUID();
    await env.sql(
      "owner",
      `INSERT INTO project_rehome_operations
      (op_id,project_id,source_bay_id,dest_bay_id,status,stage)
      VALUES($1,$2,$3,$4,'running','copying')`,
      [operation, env.project, env.bays[0], env.bays[1]],
    );
    try {
      await expect(claim()).rejects.toThrow(/rehome/);
      await expect(settle(retry[0])).rejects.toThrow(/rehome/);
    } finally {
      await env.sql(
        "owner",
        "DELETE FROM project_rehome_operations WHERE op_id=$1",
        [operation],
      );
    }
    expect(await settle(retry[0])).toBe(true);
    expect(await settle(retry[0])).toBe(false);
    expect(
      await env.sql(
        "owner",
        "SELECT id FROM collaboration_notification_recipients",
      ),
    ).toHaveLength(3);
  });
});
