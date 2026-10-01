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
acceptance("durable owner notification fanout (isolated PostgreSQL)", () => {
  let env: MultibayAcceptance;
  beforeAll(async () => {
    env = new MultibayAcceptance();
    await env.start();
  }, 240000);
  afterAll(async () => await env?.close(), 60000);

  test("live ingestion captures work atomically and retention holds unexpanded and undelivered events", async () => {
    await env.hub("a", "ensureRoom", {
      project_id: env.project,
      request_id: randomUUID(),
    });
    await env.send("a", "initialize", { request_id: randomUUID() });
    const thread = await env.send("a", "createThread", {
      request_id: randomUUID(),
      title: "Durable fanout",
    });
    // Follow routing is known before event capture, independently of view demand.
    await env.sql(
      "owner",
      "INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id) VALUES($1,$2,$3,$4)",
      [
        randomUUID(),
        env.project,
        createHash("sha256")
          .update(
            JSON.stringify([env.project, "conversation", thread.thread_id]),
          )
          .digest("hex"),
        env.accounts[1],
      ],
    );
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
    const obligation = obligations[0];
    const authorize = (overrides: object = {}) =>
      env.worker("b").call("notificationFanout", {
        operation: "authorize",
        id: obligation.id,
        account_id: obligation.account_id,
        membership_epoch: obligation.membership_epoch,
        ...overrides,
      });
    const authorized = await authorize();
    expect(authorized.event).toEqual(events[0].event_json);
    expect(authorized.attention.generation).toBe(obligation.membership_epoch);
    expect(authorized.authority.owning_bay_id).toBe(env.bays[0]);
    expect(await authorize({ account_id: env.accounts[0] })).toBeNull();
    expect(await authorize({ membership_epoch: randomUUID() })).toBeNull();
    expect(await authorize({ id: randomUUID() })).toBeNull();
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
    // Seed the canonical personal preference directly in this fixture, without
    // warming discovery just to express a follow choice.
    const key = createHash("sha256")
      .update(JSON.stringify([env.project, "conversation", thread.thread_id]))
      .digest("hex");
    await env.sql(
      "b",
      `INSERT INTO collaboration_personal(account_id,entry_key,project_id,following,following_explicit)
      VALUES($1,$2,$3,true,true)`,
      [env.accounts[1], key, env.project],
    );
    const deliver = () =>
      env.worker("owner").call("notificationFanout", {
        operation: "deliver",
        id: obligation.id,
        account_id: obligation.account_id,
        membership_epoch: obligation.membership_epoch,
      });
    const pendingReceipts = () =>
      env.worker("b").call("notificationFanout", {
        operation: "pendingReceipts",
        account_id: obligation.account_id,
        obligation_ids: [obligation.id],
      });
    expect(await pendingReceipts()).toEqual([obligation.id]);
    expect((await deliver()).status).toBe("created");
    expect((await deliver()).status).toBe("duplicate");
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "drain", lose_reply: true }),
    ).toEqual({ attempted: 1, acknowledged: 0, deferred: 1 });
    expect(
      await env.sql(
        "owner",
        "SELECT id FROM collaboration_notification_recipients WHERE event_id=$1",
        [event_id],
      ),
    ).toHaveLength(1);
    expect(
      await env.sql("b", "SELECT notification_id FROM notification_targets"),
    ).toHaveLength(1);
    expect(await env.sql("b", "SELECT * FROM collaboration_index")).toEqual([]);
    expect(
      await env.sql(
        "b",
        `SELECT generation,lease_until,
      due_at='infinity'::timestamp AS cold,lease_due_at='infinity'::timestamp AS no_renewal FROM collaboration_access`,
      ),
    ).toEqual([
      { generation: null, lease_until: null, cold: true, no_renewal: true },
    ]);
    // A remove/rejoin creates a new membership epoch; an old retained obligation
    // must not regain authority just because the same account is a member again.
    await env.sql(
      "owner",
      "UPDATE projects SET users=users-$2::text WHERE project_id=$1",
      [env.project, env.accounts[1]],
    );
    expect(await authorize()).toBeNull();
    expect(await pendingReceipts()).toEqual([obligation.id]);
    await env.sql(
      "owner",
      "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
      [
        env.project,
        JSON.stringify({ [env.accounts[1]]: { group: "collaborator" } }),
      ],
    );
    expect(await authorize()).toBeNull();
    expect(await pendingReceipts()).toEqual([obligation.id]);
    // Advance only the fixture's retry clock. The actual receiver must decide
    // revocation and the token-checked owner settlement must remove the work.
    await env.sql(
      "owner",
      "UPDATE collaboration_notification_recipients SET due_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
      [event_id],
    );
    expect(
      await env
        .worker("owner")
        .call("notificationFanout", { operation: "drain" }),
    ).toEqual({ attempted: 1, acknowledged: 1, deferred: 0 });
    expect(await pendingReceipts()).toEqual([]);
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
    // exercised actual journal ingestion. Include the immutable owner-only
    // @all admission decision that real ingestion records with the event.
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
      (event_id,project_id,generation,position,event_json,event_hash,mention_all_allowed,fanout_pending,fanout_due)
      SELECT $1,project_id,generation,2,$3,'fixture',TRUE,TRUE,now() FROM collaboration_projects WHERE project_id=$2`,
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
  test("overlapping home cleanup passes retain the winning fence across pages", async () => {
    await env.sql(
      "b",
      `INSERT INTO collaboration_notification_summary_receipts
      (account_id,event_id,event_hash,notification_id,project_id,obligation_id,cleanup_after)
      SELECT $1,gen_random_uuid(),repeat('a',64),gen_random_uuid(),$2,gen_random_uuid(),now()-interval '1 second'
      FROM generate_series(1,101)`,
      [env.accounts[1], env.project],
    );
    const first = env
      .worker("b")
      .call("notificationFanout", {
        operation: "cleanupReceipts",
        hold_ms: 1500,
      });
    for (let n = 0; n < 100; n++) {
      const rows = await env.sql(
        "b",
        "SELECT notification_cleanup_claim FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
        [env.accounts[1], env.project],
      );
      if (rows[0]?.notification_cleanup_claim) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(
      await env
        .worker("b")
        .call("notificationFanout", { operation: "cleanupReceipts" }),
    ).toBe(0);
    expect(await first).toBe(100);
    expect(
      await env
        .worker("b")
        .call("notificationFanout", { operation: "cleanupReceipts" }),
    ).toBe(1);
    expect(
      await env.sql(
        "b",
        "SELECT event_id FROM collaboration_notification_summary_receipts WHERE account_id=$1",
        [env.accounts[1]],
      ),
    ).toEqual([]);
  });
});
