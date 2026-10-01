import { pruneCollaborationSummaryReceipts } from "./collaboration-receipt-cleanup";
import { MAX_ACCOUNT_SUMMARY_RECEIPTS } from "./collaboration-summary";
import { MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS } from "@cocalc/database/postgres/collaborators/collaborators-subscription-store";
import {
  pendingNotificationReceipts,
  prepareCollaborationNotificationAuthorization,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import { flushCollaborationSummaries } from "./collaboration-summary";
import { registerCollaborationNotificationSubscription } from "@cocalc/database/postgres/collaborators/collaborators-notification-subscriptions";
import { expandCollaborationNotificationEvent } from "@cocalc/database/postgres/collaborators/collaborators-notification-fanout";
import { deliverCollaborationNotificationFanout } from "./collaboration-fanout";
import { receiveCollaborationNotificationObligation } from "./collaboration-obligation";
import { createHash, randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import * as notificationCore from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  CollaborationMessageEvent,
  CollaborationNotificationObligation,
} from "@cocalc/util/collaboration-attention";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import {
  appendCollaborationNotificationEvents,
  ensureCollaborationNotificationSchema,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import {
  initializeCollaborationProjectionAttention,
  readCollaborationNotificationObligation,
  pruneCollaborationNotificationEvents,
} from "@cocalc/database/postgres/collaborators/collaborators-notifications";
import {
  ingestCollaborationSnapshot,
  readCollaborationProjection,
} from "@cocalc/database/postgres/collaborators/collaborators-owner";
import { applyCollaborationProjection } from "@cocalc/database/postgres/collaborators/collaborators-projection";
import { setCollaborationPersonalState } from "@cocalc/database/postgres/collaborators/collaborators-discovery";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators/collaborators-common";
import { applyCollaborationAccess } from "@cocalc/database/postgres/collaborators/collaborators-access";
import { checkCollaborationRevision } from "@cocalc/database/postgres/collaborators/collaborators-changes";
import { SCHEMA } from "@cocalc/util/db-schema";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const previousBay = process.env.COCALC_BAY_ID;
const fixtures: { project_id: string; account_ids: string[] }[] = [];
beforeAll(async () => {
  process.env.COCALC_BAY_ID = `bay-notification-test-${randomUUID()}`;
  await initEphemeralDatabase();
  await ensureCollaborationNotificationSchema();
  await syncCollaboratorsSchema();
}, 30000);
afterAll(async () => {
  try {
    await getPool().end();
  } finally {
    if (previousBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = previousBay;
  }
});
afterEach(async () => {
  jest.restoreAllMocks();
  const pool = getPool();
  for (const { project_id, account_ids } of fixtures.splice(0)) {
    for (const table of [
      "notification_target_outbox",
      "notification_targets",
    ]) {
      await pool.query(
        `DELETE FROM ${table} WHERE target_account_id=ANY($1::uuid[])`,
        [account_ids],
      );
    }
    await pool.query(
      "DELETE FROM notification_events WHERE source_project_id=$1",
      [project_id],
    );
    await pool.query("DELETE FROM account_project_index WHERE project_id=$1", [
      project_id,
    ]);
    // Pending fixtures must not compete for the next test's bounded worker claims.
    for (const [table, schema] of Object.entries(SCHEMA)) {
      if (!table.startsWith("collaboration_")) continue;
      if (schema.fields.project_id) {
        await pool.query(`DELETE FROM ${table} WHERE project_id=$1`, [
          project_id,
        ]);
      } else if (schema.fields.account_id) {
        await pool.query(
          `DELETE FROM ${table} WHERE account_id=ANY($1::uuid[])`,
          [account_ids],
        );
      }
    }
    await pool.query("DELETE FROM projects WHERE project_id=$1", [project_id]);
    await pool.query("DELETE FROM accounts WHERE account_id=ANY($1::uuid[])", [
      account_ids,
    ]);
  }
});

async function fixture() {
  const project_id = randomUUID();
  const room_id = randomUUID();
  const thread_id = randomUUID();
  const actor_account_id = randomUUID();
  const account_id = randomUUID();
  fixtures.push({ project_id, account_ids: [account_id, actor_account_id] });
  const generation = randomUUID();
  const host_id = randomUUID();
  const epoch = randomUUID();
  const grant_request_id = randomUUID();
  const chat_path = "/home/user/.cocalc/collaborators.chat";
  const users = {
    [actor_account_id]: { group: "owner" },
    [account_id]: { group: "collaborator" },
  };
  const bay = getConfiguredBayId();
  const key = hash(JSON.stringify([project_id, "conversation", thread_id]));
  const resource = {
    project_id,
    kind: "conversation" as const,
    resource_id: thread_id,
    thread_id,
    chat_path,
    title: "Discussion",
    activity: 10,
    participant_ids: [actor_account_id],
    created_at: 0,
    updated_at: 0,
  };
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2),($3,$2)",
    [account_id, bay, actor_account_id],
  );
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,$3,$4::jsonb)",
    [project_id, host_id, bay, JSON.stringify(users)],
  );
  await getPool().query(
    "INSERT INTO collaboration_projects(project_id,generation) VALUES($1,$2)",
    [project_id, generation],
  );
  await getPool().query(
    "INSERT INTO collaboration_sources(source_id,project_id,chat_path,owning_bay_id,writer_host_id,epoch) VALUES($1,$2,$3,$4,$5,$6)",
    [
      hash(JSON.stringify([project_id, chat_path])),
      project_id,
      chat_path,
      bay,
      host_id,
      epoch,
    ],
  );
  await getPool().query(
    "INSERT INTO collaboration_rooms(project_id,room_id,chat_path) VALUES($1,$2,$3)",
    [project_id, room_id, chat_path],
  );
  await getPool().query(
    "INSERT INTO account_project_index(account_id,project_id,users_summary) VALUES($1,$2,$3::jsonb)",
    [account_id, project_id, JSON.stringify(users)],
  );
  await getPool().query(
    `INSERT INTO collaboration_access(account_id,project_id,generation,granted_generation,grant_request_id,lease_until)
     VALUES($1,$2,$3,$3,$4,now()+interval '1 hour')`,
    [account_id, project_id, generation, grant_request_id],
  );
  await getPool().query(
    "INSERT INTO collaboration_index(account_id,entry_key,project_id,generation,kind,metadata,participant_ids) VALUES($1,$2,$3,$4,'conversation',$5::jsonb,$6::uuid[])",
    [
      account_id,
      key,
      project_id,
      generation,
      JSON.stringify(resource),
      [actor_account_id],
    ],
  );
  await getPool().query(
    "INSERT INTO collaboration_catalog(project_id,entry_key,kind,metadata,revision,source_id) VALUES($1,$2,'conversation',$3::jsonb,1,$4)",
    [
      project_id,
      key,
      JSON.stringify(resource),
      hash(JSON.stringify([project_id, chat_path])),
    ],
  );
  const snapshot: CollaborationSourceSnapshot = {
    project_id,
    chat_path,
    epoch,
    sequence: 1,
    resources: [resource],
  };
  function event(
    activity: number,
    patch: Partial<CollaborationMessageEvent> = {},
  ): CollaborationMessageEvent {
    return {
      version: 1,
      project_id,
      room_id,
      thread_id,
      message_id: `message-${activity}`,
      actor_account_id,
      activity,
      mode: "live",
      mentioned_account_ids: [account_id],
      mention_all: false,
      ...patch,
    };
  }
  async function append(events: CollaborationMessageEvent[]) {
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      await appendCollaborationNotificationEvents(
        db,
        { ...snapshot, notification_events: events },
        { owning_bay_id: bay, host_id },
      );
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  }
  const read = (input: CollaborationNotificationObligation) =>
    readCollaborationNotificationObligation(input, { owning_bay_id: bay });
  async function run(fetch = read, loseReply = false) {
    const events = (
      await getPool().query(
        "SELECT event_id FROM collaboration_notification_events WHERE project_id=$1 AND fanout_pending ORDER BY position",
        [project_id],
      )
    ).rows;
    for (const { event_id } of events)
      await expandCollaborationNotificationEvent({ event_id, bay_id: bay });
    await getPool().query(
      "UPDATE collaboration_notification_recipients SET due_at=now() WHERE project_id=$1",
      [project_id],
    );
    return deliverCollaborationNotificationFanout({
      project_id,
      bay_id: bay,
      deliver: async (input) => {
        const result = await receiveCollaborationNotificationObligation(
          input,
          fetch,
        );
        if (loseReply) throw Error("fixture lost committed reply");
        return result;
      },
    });
  }
  async function pending() {
    return (
      await getPool().query(
        "SELECT * FROM collaboration_notification_recipients WHERE project_id=$1 AND account_id=$2",
        [project_id, account_id],
      )
    ).rows;
  }
  async function project() {
    const access = (
      await getPool().query(
        "SELECT generation,revision,after_key FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
        [account_id, project_id],
      )
    ).rows[0];
    const claim_id = randomUUID();
    await getPool().query(
      "UPDATE collaboration_access SET claim_id=$3,grant_request_id=$3 WHERE account_id=$1 AND project_id=$2",
      [account_id, project_id, claim_id],
    );
    const job = {
      ...access,
      revision: Number(access.revision),
      claim_id,
      account_id,
      project_id,
    };
    const requested_at = Date.now();
    const page = await readCollaborationProjection(job, { owning_bay_id: bay });
    expect(await applyCollaborationProjection(job, page, requested_at)).toBe(
      true,
    );
  }
  async function initialize(
    resources = snapshot.resources,
    attention_generation = generation,
  ) {
    return withAccountRehomeWriteFence({
      account_id,
      action: "test collaboration attention initialization",
      fn: (db) =>
        initializeCollaborationProjectionAttention(db, {
          account_id,
          project_id,
          generation: attention_generation,
          resources,
        }),
    });
  }
  async function personal() {
    return (
      await getPool().query(
        "SELECT * FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
        [account_id, key],
      )
    ).rows[0];
  }
  async function notifications() {
    return (
      await getPool().query(
        `SELECT e.payload_json,o.published_at FROM notification_targets t
       JOIN notification_events e USING(event_id)
       JOIN notification_target_outbox o USING(notification_id) WHERE t.target_account_id=$1`,
        [account_id],
      )
    ).rows;
  }
  async function renew() {
    const grant_request_id = randomUUID();
    await getPool().query(
      "UPDATE collaboration_access SET grant_request_id=$3 WHERE account_id=$1 AND project_id=$2",
      [account_id, project_id, grant_request_id],
    );
    expect(
      await applyCollaborationAccess(
        [{ account_id, project_id, grant_request_id }],
        [{ account_id, project_id, generation }],
        Date.now(),
      ),
    ).toBe(1);
    return grant_request_id;
  }
  return {
    event,
    append,
    run,
    project,
    initialize,
    personal,
    notifications,
    pending,
    renew,
    read,
    users,
    account_id,
    actor_account_id,
    project_id,
    generation,
    key,
    snapshot,
    resource,
    bay,
    host_id,
  };
}

it("delivers a persisted server message through SQL attention and existing outbox after a no-history handoff", async () => {
  const f = await fixture();
  const users = { [f.actor_account_id]: { group: "owner" } };
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify(users)],
  );
  await ingestCollaborationSnapshot(
    { ...f.snapshot, notification_events: [f.event(1)] },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify(f.users)],
  );
  await f.project();
  await f.run();
  expect(await f.notifications()).toHaveLength(0);
  await getPool().query(
    "UPDATE collaboration_personal SET muted=true WHERE account_id=$1 AND entry_key=$2",
    [f.account_id, f.key],
  );
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      resources: f.snapshot.resources.map((r) => ({ ...r, activity: 11 })),
      notification_events: [f.event(11)],
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await f.project();
  const pass = await f.run();
  expect(pass.deferred).toBe(0);
  const notifications = await f.notifications();
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    published_at: null,
    payload_json: { notification_reason: "mention", message_id: "message-11" },
  });
  const state = (
    await getPool().query(
      "SELECT following,muted,last_mention,read_through,legacy_migrated FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
      [f.account_id, f.key],
    )
  ).rows[0];
  expect(state).toMatchObject({
    following: false,
    muted: true,
    legacy_migrated: true,
  });
  expect(Number(state.last_mention)).toBe(11);
  expect(Number(state.read_through)).toBe(10);
  await f.run();
  expect(await f.notifications()).toHaveLength(1);
});

it("delivers the first mention in a new thread to an existing project member", async () => {
  const f = await fixture();
  const authority = { owning_bay_id: f.bay, host_id: f.host_id };
  await ingestCollaborationSnapshot(f.snapshot, authority);
  await f.project();
  await f.run();
  const thread_id = randomUUID();
  const resource = {
    ...f.snapshot.resources[0],
    resource_id: thread_id,
    thread_id,
    activity: 1,
  };
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      resources: [...f.snapshot.resources, resource],
      notification_events: [f.event(1, { thread_id })],
    },
    authority,
  );
  await f.project();
  const personal = (
    await getPool().query(
      "SELECT read_through,notify_after FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
      [
        f.account_id,
        hash(JSON.stringify([f.project_id, "conversation", thread_id])),
      ],
    )
  ).rows[0];
  expect(Number(personal.read_through)).toBe(0);
  expect(Number(personal.notify_after)).toBe(0);
  expect((await f.run()).deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(1);
  expect((await f.notifications())[0].payload_json.message_id).toBe(
    "message-1",
  );
});

it("keeps unread activity and pending mentions across an unrelated third-member addition", async () => {
  const f = await fixture();
  const authority = { owning_bay_id: f.bay, host_id: f.host_id };
  await ingestCollaborationSnapshot(f.snapshot, authority);
  await f.project();
  await f.run();
  const before = await f.personal();
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      resources: f.snapshot.resources.map((r) => ({ ...r, activity: 11 })),
      notification_events: [f.event(11)],
    },
    authority,
  );
  await f.project();
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [
      f.project_id,
      JSON.stringify({ ...f.users, [randomUUID()]: { group: "collaborator" } }),
    ],
  );
  await f.project();
  const after = await f.personal();
  expect(after.attention_generation).toBe(before.attention_generation);
  expect(Number(after.read_through)).toBe(10);
  expect(Number(after.notify_after)).toBe(10);
  expect((await f.run()).deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(1);
  expect(Number((await f.personal()).read_through)).toBe(10);
  expect((await f.personal()).attention_generation).toBe(
    before.attention_generation,
  );
});

it("honors an unobserved remove/rejoin cutover without dropping a post-rejoin mention", async () => {
  const f = await fixture();
  const authority = { owning_bay_id: f.bay, host_id: f.host_id };
  await ingestCollaborationSnapshot(f.snapshot, authority);
  await f.project();
  await f.run();
  const before = (await f.personal()).attention_generation;
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      resources: f.snapshot.resources.map((r) => ({ ...r, activity: 11 })),
      notification_events: [f.event(11)],
    },
    authority,
  );
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [
      f.project_id,
      JSON.stringify({ [f.actor_account_id]: { group: "owner" } }),
    ],
  );
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify(f.users)],
  );
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 3,
      resources: f.snapshot.resources.map((r) => ({ ...r, activity: 12 })),
      notification_events: [f.event(12)],
    },
    authority,
  );
  await f.project();
  expect((await f.personal()).attention_generation).not.toBe(before);
  expect(Number((await f.personal()).read_through)).toBe(11);
  await f.run();
  const notifications = await f.notifications();
  expect(notifications).toHaveLength(1);
  expect(notifications[0].payload_json.message_id).toBe("message-12");
});

it("ingests event-only snapshots through the owner transaction and delivers them exactly once", async () => {
  const f = await fixture();
  await f.run();
  const authority = { owning_bay_id: f.bay, host_id: f.host_id };
  const first = await ingestCollaborationSnapshot(
    { ...f.snapshot, notification_events: [f.event(1)] },
    authority,
  );
  expect(first.replayed).toBe(false);
  const next = {
    ...f.snapshot,
    sequence: 2,
    notification_events: [f.event(2)],
  };
  // Metadata does not change, but the source journal still has new durable intent.
  expect(await ingestCollaborationSnapshot(next, authority)).toEqual({
    revision: first.revision,
    replayed: true,
  });
  await ingestCollaborationSnapshot(next, authority);
  expect((await f.run()).deferred).toBe(0);
  expect(
    (await f.notifications()).map((row) => row.payload_json.message_id).sort(),
  ).toEqual(["message-1", "message-2"]);
  const events = await getPool().query(
    "SELECT event_id FROM collaboration_notification_events WHERE project_id=$1",
    [f.project_id],
  );
  expect(events.rows).toHaveLength(2);

  // A replay after retention must not resurrect already acknowledged source intent.
  await getPool().query(
    "UPDATE collaboration_notification_events SET created_at=now()-interval '31 days' WHERE project_id=$1",
    [f.project_id],
  );
  await pruneCollaborationNotificationEvents(f.bay);
  await ingestCollaborationSnapshot(next, authority);
  expect(
    (
      await getPool().query(
        "SELECT event_id FROM collaboration_notification_events WHERE project_id=$1",
        [f.project_id],
      )
    ).rows,
  ).toHaveLength(0);
});

it("rolls back source metadata when event ingest rejects a changed message replay", async () => {
  const f = await fixture();
  const authority = { owning_bay_id: f.bay, host_id: f.host_id };
  await ingestCollaborationSnapshot(
    { ...f.snapshot, notification_events: [f.event(1)] },
    authority,
  );
  await expect(
    ingestCollaborationSnapshot(
      {
        ...f.snapshot,
        sequence: 2,
        resources: f.snapshot.resources.map((r) => ({
          ...r,
          title: "Uncommitted",
        })),
        notification_events: [f.event(1, { mention_all: true })],
      },
      authority,
    ),
  ).rejects.toThrow("changed on replay");
  const source = (
    await getPool().query(
      "SELECT source_sequence FROM collaboration_sources WHERE project_id=$1 AND chat_path=$2",
      [f.project_id, f.snapshot.chat_path],
    )
  ).rows[0];
  expect(Number(source.source_sequence)).toBe(1);
  const catalog = (
    await getPool().query(
      "SELECT metadata FROM collaboration_catalog WHERE project_id=$1",
      [f.project_id],
    )
  ).rows;
  expect(catalog).toHaveLength(1);
  expect(catalog[0].metadata.title).toBe("Discussion");
});

it("retries a retained obligation after a graph transaction failure without duplicate notifications", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(1), f.event(2)]);
  const original = notificationCore.createNotificationEventGraphInTransaction;
  jest
    .spyOn(notificationCore, "createNotificationEventGraphInTransaction")
    .mockImplementationOnce(original)
    .mockImplementationOnce(async (opts) => {
      await original(opts);
      throw Error("lost connection before commit");
    });
  expect((await f.run()).deferred).toBe(1);
  expect(await f.pending()).toHaveLength(1);
  expect(await f.notifications()).toHaveLength(1);
  const replay = await f.run();
  expect(replay.deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(2);
});

it("preserves out-of-order live messages without treating delivery order as a read position", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(3), f.event(2)]);
  await f.run();
  expect(await f.notifications()).toHaveLength(2);
});

it("delivers to offline recipients with expired discovery leases", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE collaboration_access SET lease_until=now()-interval '1 day', granted_generation=NULL WHERE account_id=$1",
    [f.account_id],
  );
  await f.append([f.event(1)]);
  expect((await f.run()).deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(1);
});

it("retains intent when a newer home authorization supersedes the owner RPC", async () => {
  const f = await fixture();
  await f.append([f.event(1)]);
  const pass = await f.run(async (input) => {
    const entry = await f.read(input);
    await f.renew();
    return entry;
  });
  expect(pass.deferred).toBe(1);
  expect(await f.notifications()).toHaveLength(0);
  expect(await f.pending()).toHaveLength(1);
  expect((await f.run()).deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(1);
});

it("suppresses backfill, makes source replay idempotent, and rejects changed event facts", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(1, { mode: "backfill" })]);
  await f.run();
  expect(await f.notifications()).toHaveLength(0);
  await f.append([f.event(2)]);
  await f.append([f.event(2)]);
  await expect(f.append([f.event(2, { mention_all: true })])).rejects.toThrow(
    "changed on replay",
  );
  await f.run();
  expect(await f.notifications()).toHaveLength(1);
});

it("never delivers pending mentions to a removed collaborator", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(1, { mention_all: true })]);
  delete f.users[f.account_id];
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify(f.users)],
  );
  await f.run();
  expect(await f.notifications()).toHaveLength(0);
  expect(await f.pending()).toHaveLength(0);
});

it("rejects a host/epoch mismatch before persisting event intent", async () => {
  const f = await fixture();
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await expect(
      appendCollaborationNotificationEvents(
        db,
        {
          ...f.snapshot,
          epoch: randomUUID(),
          notification_events: [f.event(1)],
        },
        { owning_bay_id: f.bay, host_id: f.host_id },
      ),
    ).rejects.toThrow("stale");
    await db.query("ROLLBACK");
  } finally {
    db.release();
  }
  expect(
    (
      await getPool().query(
        "SELECT event_id FROM collaboration_notification_events WHERE project_id=$1",
        [f.project_id],
      )
    ).rows,
  ).toHaveLength(0);
});

it("retains old undelivered intent and prunes only after settlement", async () => {
  const f = await fixture();
  await f.append([f.event(1), f.event(2)]);
  await getPool().query(
    "UPDATE collaboration_notification_events SET created_at=now()-interval '31 days' WHERE project_id=$1",
    [f.project_id],
  );
  expect(await pruneCollaborationNotificationEvents(f.bay)).toBe(0);
  expect((await f.run()).deferred).toBe(0);
  expect(await f.notifications()).toHaveLength(2);
  expect(await pruneCollaborationNotificationEvents(f.bay)).toBe(2);
});

it("reconciles adopted legacy choices once and respects explicit personal opt-out", async () => {
  const f = await fixture();
  await f.run();
  const resources = f.snapshot.resources.map((resource) => ({
    ...resource,
    notification_followers: [f.account_id],
    notification_muted: [],
  }));
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      resources,
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await f.project();
  expect(Number((await f.personal()).read_through)).toBe(10);
  expect((await f.personal()).following).toBe(true);
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      resources: resources.map((r) => ({ ...r, activity: 11 })),
      notification_events: [f.event(11, { mentioned_account_ids: [] })],
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await f.project();
  await f.run();
  expect(await f.notifications()).toHaveLength(1);
  await getPool().query(
    "UPDATE collaboration_personal SET following=false,following_explicit=true WHERE account_id=$1 AND entry_key=$2",
    [f.account_id, f.key],
  );
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 3,
      resources: resources.map((r) => ({ ...r, activity: 12 })),
      notification_events: [f.event(12, { mentioned_account_ids: [] })],
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await f.project();
  await f.run();
  expect(await f.notifications()).toHaveLength(1);
});

it("sets monotone first-observation floors without reading subsequent activity or another thread", async () => {
  const f = await fixture();
  expect(await f.initialize()).toBe(1);
  expect(await f.personal()).toMatchObject({
    attention_generation: f.generation,
    following: false,
    muted: false,
    legacy_migrated: true,
  });
  expect(Number((await f.personal()).read_through)).toBe(10);
  expect(Number((await f.personal()).notify_after)).toBe(10);
  await getPool().query(
    "UPDATE collaboration_personal SET read_through=15,last_mention=19 WHERE account_id=$1 AND entry_key=$2",
    [f.account_id, f.key],
  );
  const newer = f.snapshot.resources.map((r) => ({ ...r, activity: 20 }));
  expect(await f.initialize(newer)).toBe(0);
  expect(Number((await f.personal()).read_through)).toBe(15);
  expect(Number((await f.personal()).notify_after)).toBe(10);
  const other = f.snapshot.resources.map((r) => ({
    ...r,
    thread_id: "another",
    resource_id: "another",
    activity: 7,
  }));
  expect(await f.initialize(other)).toBe(1);
  expect(Number((await f.personal()).read_through)).toBe(15);
  const nextGeneration = randomUUID();
  expect(await f.initialize(newer, nextGeneration)).toBe(1);
  expect(Number((await f.personal()).read_through)).toBe(20);
  expect(Number((await f.personal()).notify_after)).toBe(20);
  expect(Number((await f.personal()).last_mention)).toBe(19);
  expect(await f.initialize(f.snapshot.resources, randomUUID())).toBe(1);
  expect(Number((await f.personal()).read_through)).toBe(20);
  expect(Number((await f.personal()).notify_after)).toBe(20);
});

it("preserves explicit opt-outs, aliases and collections when adopting legacy attention", async () => {
  const f = await fixture();
  await getPool().query(
    `INSERT INTO collaboration_personal(account_id,entry_key,project_id,following,following_explicit,muted,muted_explicit,alias,collected,read_through)
     VALUES($1,$2,$3,false,true,false,true,'Private name',true,12)`,
    [f.account_id, f.key, f.project_id],
  );
  await f.initialize(
    f.snapshot.resources.map((r) => ({
      ...r,
      notification_followers: [f.account_id],
      notification_muted: [f.account_id],
    })),
  );
  expect(await f.personal()).toMatchObject({
    following: false,
    following_explicit: true,
    muted: false,
    muted_explicit: true,
    alias: "Private name",
    collected: true,
    legacy_migrated: true,
  });
  expect(Number((await f.personal()).read_through)).toBe(12);
  expect(Number((await f.personal()).notify_after)).toBe(10);
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "preserves concurrent reads during projection initialization and generation changes",
  async () => {
    const f = await fixture();
    await f.initialize();
    const resource = { ...f.snapshot.resources[0], activity: 40 };
    await Promise.all([
      f.initialize([resource]),
      setCollaborationPersonalState(
        f.account_id,
        resource,
        { read_through: 15 },
        resource,
      ),
      f.initialize([resource]),
    ]);
    expect(Number((await f.personal()).read_through)).toBe(15);
    expect(Number((await f.personal()).notify_after)).toBe(10);
    await Promise.all([
      f.initialize([{ ...resource, activity: 20 }], randomUUID()),
      setCollaborationPersonalState(
        f.account_id,
        resource,
        { read_through: 30 },
        resource,
      ),
    ]);
    expect(Number((await f.personal()).read_through)).toBe(30);
    expect(Number((await f.personal()).notify_after)).toBe(20);
  },
);

it("honors an already-read position without making other source messages read", async () => {
  const f = await fixture();
  await f.run();
  await getPool().query(
    "INSERT INTO collaboration_personal(account_id,entry_key,project_id,read_through) VALUES($1,$2,$3,2)",
    [f.account_id, f.key, f.project_id],
  );
  await f.append([f.event(1), f.event(2), f.event(3)]);
  await f.run();
  const delivered = await f.notifications();
  expect(delivered).toHaveLength(1);
  expect(delivered[0].payload_json.message_id).toBe("message-3");
  const personal = (
    await getPool().query(
      "SELECT read_through FROM collaboration_personal WHERE account_id=$1 AND entry_key=$2",
      [f.account_id, f.key],
    )
  ).rows[0];
  expect(Number(personal.read_through)).toBe(2);
});

it("does not route ordinary messages to unrelated project members", async () => {
  const f = await fixture();
  const users = Object.fromEntries(
    Array.from({ length: 500 }, () => [
      randomUUID(),
      { group: "collaborator" },
    ]),
  );
  await getPool().query(
    "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify(users)],
  );
  await f.append([f.event(1, { mentioned_account_ids: [] })]);
  expect(await f.run()).toEqual({ attempted: 0, acknowledged: 0, deferred: 0 });
  await registerCollaborationNotificationSubscription(
    {
      project_id: f.project_id,
      account_id: f.account_id,
      thread_id: f.resource.thread_id,
    },
    { owning_bay_id: getConfiguredBayId() },
  );
  await setCollaborationPersonalState(
    f.account_id,
    f.resource,
    { following: true },
    f.resource,
  );
  await f.append([f.event(2, { mentioned_account_ids: [] })]);
  expect(await f.run()).toEqual({ attempted: 1, acknowledged: 1, deferred: 0 });
  expect(await f.notifications()).toHaveLength(1);
});

it("groups overflow durably, deduplicates retries and drains without view demand", async () => {
  const f = await fixture();
  await f.append(Array.from({ length: 10 }, (_, i) => f.event(i + 1)));
  expect(await f.run(undefined, true)).toEqual({
    attempted: 4,
    acknowledged: 0,
    deferred: 4,
  });
  await f.run();
  await f.run();
  await f.run();
  expect(await f.notifications()).toHaveLength(3);
  const pending = (
    await getPool().query(
      "SELECT * FROM collaboration_notification_summary WHERE account_id=$1",
      [f.account_id],
    )
  ).rows[0];
  expect(Number(pending.count)).toBe(7);
  expect(
    (
      await getPool().query(
        "SELECT * FROM collaboration_notification_summary_receipts WHERE account_id=$1",
        [f.account_id],
      )
    ).rows,
  ).toHaveLength(7);
  // Replayed source snapshots must not charge or count overflow again.
  await f.append(Array.from({ length: 10 }, (_, i) => f.event(i + 1)));
  await f.run();
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count FROM collaboration_notification_summary WHERE account_id=$1",
          [f.account_id],
        )
      ).rows[0].count,
    ),
  ).toBe(7);
  expect(await flushCollaborationSummaries(getConfiguredBayId())).toBe(0);
  await getPool().query("DELETE FROM collaboration_index WHERE account_id=$1", [
    f.account_id,
  ]);
  await getPool().query(
    "UPDATE collaboration_notification_summary SET due_at=now()-interval '1 second' WHERE account_id=$1",
    [f.account_id],
  );
  expect(await flushCollaborationSummaries("wrong-home")).toBe(0);
  expect(await flushCollaborationSummaries(getConfiguredBayId())).toBe(1);
  expect(await flushCollaborationSummaries(getConfiguredBayId())).toBe(0);
  const notifications = await f.notifications();
  expect(notifications).toHaveLength(4);
  expect(
    notifications.find(
      (n) => n.payload_json.notice_type === "collaboration_summary",
    )?.payload_json.grouped_notifications,
  ).toBe(7);
  expect(
    (
      await getPool().query(
        "SELECT * FROM collaboration_index WHERE account_id=$1",
        [f.account_id],
      )
    ).rows,
  ).toEqual([]);
});

it("one actor's recipient burst does not consume another actor's individual allowance", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await f.run();
  const actor = randomUUID();
  await getPool().query(
    "UPDATE projects SET users=users || $2::jsonb WHERE project_id=$1",
    [f.project_id, JSON.stringify({ [actor]: { group: "collaborator" } })],
  );
  await f.append([f.event(5, { actor_account_id: actor })]);
  await f.run();
  expect(await f.notifications()).toHaveLength(4);
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count FROM collaboration_notification_summary WHERE account_id=$1",
          [f.account_id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
});

it("an ordinary collaborator cannot turn @all into project-wide delivery", async () => {
  const f = await fixture();
  await getPool().query(
    "UPDATE projects SET users=jsonb_set(users,ARRAY[$2::text,'group'],'\"collaborator\"'::jsonb) WHERE project_id=$1",
    [f.project_id, f.actor_account_id],
  );
  await f.append([
    f.event(1, { mentioned_account_ids: [], mention_all: true }),
  ]);
  expect(await f.run()).toEqual({ attempted: 0, acknowledged: 0, deferred: 0 });
  await f.append([f.event(2, { mention_all: true })]);
  expect(await f.run()).toEqual({ attempted: 1, acknowledged: 1, deferred: 0 });
});

it("keeps owner routing intent when a source-file follow is later removed from metadata", async () => {
  const f = await fixture();
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      resources: [
        { ...f.resource, notification_followers: [f.account_id] },
      ] as any,
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  await setCollaborationPersonalState(
    f.account_id,
    f.resource,
    { following: true },
    f.resource,
  );
  await ingestCollaborationSnapshot(
    {
      ...f.snapshot,
      sequence: 2,
      notification_events: [f.event(1, { mentioned_account_ids: [] })],
    },
    { owning_bay_id: f.bay, host_id: f.host_id },
  );
  expect(await f.run()).toEqual({ attempted: 1, acknowledged: 1, deferred: 0 });
});

it("bounds both follower admission paths per project and canonicalizes UUID case", async () => {
  const f = await fixture();
  const register = (account_id = f.account_id) =>
    registerCollaborationNotificationSubscription(
      {
        project_id: f.project_id,
        account_id,
        thread_id: f.resource.thread_id,
      },
      { owning_bay_id: f.bay },
    );
  await register();
  await register(f.account_id.toUpperCase());
  await getPool().query(
    `INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id)
     SELECT md5(n::text),$1,md5(n::text),$2 FROM generate_series(1,$3::int) n`,
    [f.project_id, f.account_id, MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS - 1],
  );
  await register(); // Idempotent at capacity.
  await expect(register(f.actor_account_id)).rejects.toThrow(
    "project notification subscription limit",
  );
  await expect(
    ingestCollaborationSnapshot(
      {
        ...f.snapshot,
        sequence: 2,
        resources: [
          {
            ...f.resource,
            notification_followers: [f.actor_account_id.toUpperCase()],
          } as typeof f.resource,
        ],
      },
      { owning_bay_id: f.bay, host_id: f.host_id },
    ),
  ).rejects.toThrow("project notification subscription limit");
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count(*) AS n FROM collaboration_notification_subscriptions WHERE project_id=$1",
          [f.project_id],
        )
      ).rows[0].n,
    ),
  ).toBe(MAX_PROJECT_NOTIFICATION_SUBSCRIPTIONS);
  // SQL uniqueness also rejects a noncanonical physical id for the same tuple.
  await expect(
    getPool().query(
      "INSERT INTO collaboration_notification_subscriptions(id,project_id,entry_key,account_id) VALUES('duplicate',$1,$2,$3)",
      [f.project_id, f.key, f.account_id.toUpperCase()],
    ),
  ).rejects.toThrow(/unique|duplicate/i);
});

const receiptsDue = (account: string) =>
  getPool().query(
    "UPDATE collaboration_notification_summary_receipts SET cleanup_after=now()-interval '1 second' WHERE account_id=$1",
    [account],
  );

it("retains lost-ack receipts until exact settlement, even after summary flush or room loss", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await f.run(undefined, true);
  const inspect = (input) =>
    pendingNotificationReceipts(input, { owning_bay_id: f.bay });
  await receiptsDue(f.account_id);
  expect(
    await pruneCollaborationSummaryReceipts(f.bay, async () => {
      throw Error("owner unavailable");
    }),
  ).toBe(0);
  await receiptsDue(f.account_id);
  await getPool().query(
    "UPDATE collaboration_catalog SET deleted_at=now() WHERE project_id=$1",
    [f.project_id],
  );
  // Unavailable content is not proof of settlement.
  expect(await pruneCollaborationSummaryReceipts(f.bay, inspect)).toBe(0);
  await getPool().query(
    "UPDATE collaboration_catalog SET deleted_at=NULL WHERE project_id=$1",
    [f.project_id],
  );
  await getPool().query(
    "UPDATE collaboration_notification_summary SET due_at=now()-interval '1 second' WHERE account_id=$1",
    [f.account_id],
  );
  expect(await flushCollaborationSummaries(f.bay)).toBe(1);
  await receiptsDue(f.account_id);
  expect(await pruneCollaborationSummaryReceipts(f.bay, inspect)).toBe(0);
  await f.run(); // Retry lost acknowledgment; duplicate does not recount.
  await receiptsDue(f.account_id);
  expect(await pruneCollaborationSummaryReceipts(f.bay, inspect)).toBe(1);
  expect(await f.notifications()).toHaveLength(4);
});

it("receipt cleanup invalidates an owner answer captured before settlement", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await f.run(undefined, true);
  const receipt = (
    await getPool().query(
      "SELECT * FROM collaboration_notification_summary_receipts WHERE account_id=$1",
      [f.account_id],
    )
  ).rows[0];
  const r = (
    await getPool().query(
      "SELECT * FROM collaboration_notification_recipients WHERE id=$1",
      [receipt.obligation_id],
    )
  ).rows[0];
  const input = {
    project_id: f.project_id,
    account_id: f.account_id,
    id: r.id,
    membership_epoch: r.membership_epoch,
  };
  await expect(
    receiveCollaborationNotificationObligation(input, async (q) => {
      const entry = await f.read(q);
      await getPool().query(
        "DELETE FROM collaboration_notification_recipients WHERE id=$1",
        [r.id],
      );
      await receiptsDue(f.account_id);
      expect(
        await pruneCollaborationSummaryReceipts(f.bay, (query) =>
          pendingNotificationReceipts(query, { owning_bay_id: f.bay }),
        ),
      ).toBe(1);
      return entry;
    }),
  ).rejects.toThrow(/superseded/);
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count FROM collaboration_notification_summary WHERE account_id=$1",
          [f.account_id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
});

it("bounds receipt storage and leaves excess work durable until cleanup makes room", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await getPool().query(
    `INSERT INTO collaboration_notification_summary_receipts(account_id,event_id,event_hash,notification_id,project_id,obligation_id)
     SELECT $1,gen_random_uuid(),repeat('a',64),gen_random_uuid(),$2,gen_random_uuid() FROM generate_series(1,$3::int)`,
    [f.account_id, f.project_id, MAX_ACCOUNT_SUMMARY_RECEIPTS],
  );
  expect(await f.run()).toEqual({ attempted: 4, acknowledged: 3, deferred: 1 });
  expect(
    (
      await getPool().query(
        "SELECT * FROM collaboration_notification_summary WHERE account_id=$1",
        [f.account_id],
      )
    ).rows,
  ).toHaveLength(0);
  await receiptsDue(f.account_id);
  expect(
    await pruneCollaborationSummaryReceipts(f.bay, (q) =>
      pendingNotificationReceipts(q, { owning_bay_id: f.bay }),
    ),
  ).toBe(100);
  expect(await f.run()).toEqual({ attempted: 1, acknowledged: 1, deferred: 0 });
  expect(
    Number(
      (
        await getPool().query(
          "SELECT count FROM collaboration_notification_summary WHERE account_id=$1",
          [f.account_id],
        )
      ).rows[0].count,
    ),
  ).toBe(1);
});

it("retains receipts if a newer authorization supersedes the cleanup proof", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await f.run();
  await receiptsDue(f.account_id);
  expect(
    await pruneCollaborationSummaryReceipts(f.bay, async (input) => {
      const result = await pendingNotificationReceipts(input, {
        owning_bay_id: f.bay,
      });
      await prepareCollaborationNotificationAuthorization(
        f.account_id,
        f.project_id,
      );
      return result;
    }),
  ).toBe(0);
  await receiptsDue(f.account_id);
  expect(
    await pruneCollaborationSummaryReceipts(f.bay, (q) =>
      pendingNotificationReceipts(q, { owning_bay_id: f.bay }),
    ),
  ).toBe(1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

it.each([1, 101])(
  "serializes competing cleanup replicas with %i due receipts",
  async (count) => {
    const f = await fixture();
    await getPool().query(
      `INSERT INTO collaboration_notification_summary_receipts(account_id,event_id,event_hash,notification_id,project_id,obligation_id,cleanup_after)
     SELECT $1,gen_random_uuid(),repeat('a',64),gen_random_uuid(),$2,gen_random_uuid(),now()-interval '1 second' FROM generate_series(1,$3::int)`,
      [f.account_id, f.project_id, count],
    );
    const entered = deferred(),
      release = deferred();
    const pending = jest.fn(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const first = pruneCollaborationSummaryReceipts(f.bay, pending);
    await entered.promise;
    try {
      expect(await pruneCollaborationSummaryReceipts(f.bay, pending)).toBe(0);
      expect(pending).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
    }
    expect(await first).toBe(Math.min(count, 100));
    expect(await pruneCollaborationSummaryReceipts(f.bay, async () => [])).toBe(
      Math.max(0, count - 100),
    );
  },
);

it("recovers an expired cleanup claim without letting its old worker release the replacement", async () => {
  const f = await fixture();
  await f.append([1, 2, 3, 4].map((n) => f.event(n)));
  await f.run();
  await receiptsDue(f.account_id);
  const entered = deferred(),
    release = deferred(),
    replacementEntered = deferred(),
    replacementRelease = deferred();
  const first = pruneCollaborationSummaryReceipts(f.bay, async () => {
    entered.resolve();
    await release.promise;
    return [];
  });
  await entered.promise;
  await getPool().query(
    `UPDATE collaboration_access SET notification_cleanup_until=now()-interval '1 second' WHERE account_id=$1`,
    [f.account_id],
  );
  await receiptsDue(f.account_id);
  const replacement = pruneCollaborationSummaryReceipts(f.bay, async () => {
    replacementEntered.resolve();
    await replacementRelease.promise;
    return [];
  });
  await replacementEntered.promise;
  release.resolve();
  expect(await first).toBe(0);
  try {
    expect(
      (
        await getPool().query(
          `SELECT notification_cleanup_claim FROM collaboration_access WHERE account_id=$1 AND project_id=$2`,
          [f.account_id, f.project_id],
        )
      ).rows[0].notification_cleanup_claim,
    ).not.toBeNull();
  } finally {
    replacementRelease.resolve();
  }
  expect(await replacement).toBe(1);
});
