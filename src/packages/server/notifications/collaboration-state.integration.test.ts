import { createHash, randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import * as notificationCore from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  CollaborationMessageEvent,
  CollaborationNotificationOutboxStore,
} from "@cocalc/util/collaboration-attention";
import type { CollaborationSourceSnapshot } from "@cocalc/util/collaborators";
import {
  appendCollaborationNotificationEvents,
  ensureCollaborationNotificationSchema,
  readCollaborationNotificationPage,
  runCollaborationNotificationMaintenance,
} from "./collaboration-state";
import {
  initializeCollaborationProjectionAttention,
  collaborationNotificationStore,
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
  const readPage: CollaborationNotificationOutboxStore["readPage"] = (
    job,
    limit,
  ) => readCollaborationNotificationPage(job, { owning_bay_id: bay }, limit);
  const store = collaborationNotificationStore(readPage, bay);
  async function run(fetch = readPage) {
    await getPool().query(
      "UPDATE collaboration_notification_cursors SET due_at=now() WHERE account_id=$1 AND project_id=$2",
      [account_id, project_id],
    );
    return runCollaborationNotificationMaintenance(fetch);
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
  async function cursor() {
    return (
      await getPool().query(
        "SELECT * FROM collaboration_notification_cursors WHERE account_id=$1 AND project_id=$2",
        [account_id, project_id],
      )
    ).rows[0];
  }
  async function claim() {
    const claim_id = randomUUID();
    const cursor = (
      await getPool().query(
        `UPDATE collaboration_notification_cursors SET claim_id=$3,claim_until=now()+interval '90 seconds'
       WHERE account_id=$1 AND project_id=$2 RETURNING *`,
        [account_id, project_id, claim_id],
      )
    ).rows[0];
    const access = (
      await getPool().query(
        "SELECT grant_request_id FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
        [account_id, project_id],
      )
    ).rows[0];
    return { ...cursor, grant_request_id: access.grant_request_id };
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
    cursor,
    claim,
    renew,
    store,
    readPage,
    users,
    account_id,
    actor_account_id,
    project_id,
    generation,
    key,
    snapshot,
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
  expect((await f.cursor()).generation).toBe(
    (await f.personal()).attention_generation,
  );
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
  expect(pass.failed).toBe(0);
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
  expect((await f.run()).failed).toBe(0);
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
  const cursor = await f.cursor();
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
  const page = await readCollaborationNotificationPage(
    { ...cursor, claim_id: randomUUID() },
    authority,
  );
  expect(page).toMatchObject({
    allowed: true,
    reset: false,
    generation: cursor.generation,
  });
  expect((await f.run()).failed).toBe(0);
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
  expect(await f.notifications()).toHaveLength(0);
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
  expect((await f.run()).failed).toBe(0);
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

it("replays an unacknowledged page after a partial graph failure without duplicate notifications", async () => {
  const f = await fixture();
  await f.run();
  const before = (await f.cursor()).cursor;
  await f.append([f.event(1), f.event(2)]);
  const original = notificationCore.createNotificationEventGraphInTransaction;
  jest
    .spyOn(notificationCore, "createNotificationEventGraphInTransaction")
    .mockImplementationOnce(original)
    .mockImplementationOnce(async (opts) => {
      await original(opts);
      throw Error("lost connection before commit");
    });
  expect((await f.run()).failed).toBe(1);
  expect((await f.cursor()).cursor).toBe(before);
  expect(await f.notifications()).toHaveLength(1);
  const replay = await f.run();
  expect(replay.failed).toBe(0);
  expect(replay.duplicate).toBe(1);
  expect(await f.notifications()).toHaveLength(2);
});

it("preserves out-of-order live messages without treating delivery order as a read position", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(3), f.event(2)]);
  await f.run();
  expect(await f.notifications()).toHaveLength(2);
});

it.each(["expired", "revoked", "newer"])(
  "keeps event intent retryable when the home grant is %s",
  async (invalid) => {
    const f = await fixture();
    await f.run();
    const before = (await f.cursor()).cursor;
    await f.append([f.event(1)]);
    if (invalid === "expired") {
      await getPool().query(
        "UPDATE collaboration_access SET lease_until=now()-interval '1 second' WHERE account_id=$1 AND project_id=$2",
        [f.account_id, f.project_id],
      );
    } else {
      await getPool().query(
        "UPDATE collaboration_access SET granted_generation=$3 WHERE account_id=$1 AND project_id=$2",
        [
          f.account_id,
          f.project_id,
          invalid === "revoked" ? null : randomUUID(),
        ],
      );
    }
    expect((await f.run()).failed).toBe(1);
    expect(await f.notifications()).toHaveLength(0);
    expect(await f.personal()).toBeUndefined();
    expect((await f.cursor()).cursor).toBe(before);
    const job = await f.claim();
    await expect(
      f.store.acknowledge(job, await f.readPage(job, 25)),
    ).rejects.toThrow(
      invalid === "expired" ? "lease expired" : "grant not ready",
    );
    expect((await f.cursor()).cursor).toBe(before);
    await f.store.fail(job, Error("retry after renewal"));
    await f.renew();
    expect((await f.run()).failed).toBe(0);
    expect(await f.notifications()).toHaveLength(1);
  },
);

it("retries when a newer home grant supersedes the notification's owner RPC", async () => {
  const f = await fixture();
  await f.run();
  const before = (await f.cursor()).cursor;
  await f.append([f.event(1)]);
  const pass = await f.run(async (job, limit) => {
    const page = await f.readPage(job, limit);
    if (job.account_id === f.account_id) await f.renew();
    return page;
  });
  expect(pass.failed).toBe(1);
  expect(await f.notifications()).toHaveLength(0);
  expect((await f.cursor()).cursor).toBe(before);
  expect((await f.run()).failed).toBe(0);
  expect(await f.notifications()).toHaveLength(1);
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "rejects a lease that expires while notification delivery waits for the access lock",
  async () => {
    const f = await fixture();
    await f.run();
    await f.append([f.event(1)]);
    const before = (await f.cursor()).cursor;
    const blocker = await getPool().connect();
    let committed = false;
    let pending: ReturnType<typeof f.run> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "UPDATE collaboration_access SET lease_until=clock_timestamp()+interval '100 milliseconds' WHERE account_id=$1 AND project_id=$2",
        [f.account_id, f.project_id],
      );
      pending = f.run();
      await blocker.query("SELECT pg_sleep(0.2)");
      await blocker.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await blocker.query("ROLLBACK");
      blocker.release();
    }
    expect((await pending!)!.failed).toBe(1);
    expect(await f.notifications()).toHaveLength(0);
    expect((await f.cursor()).cursor).toBe(before);
    await f.renew();
    expect((await f.run()).failed).toBe(0);
    expect(await f.notifications()).toHaveLength(1);
  },
);

it("does not let a stale denied page erase a newer accepted access grant", async () => {
  const f = await fixture();
  await f.run();
  const job = await f.claim();
  const newer = await f.renew();
  await expect(f.store.acknowledge(job, { allowed: false })).rejects.toThrow(
    "superseded",
  );
  const access = (
    await getPool().query(
      "SELECT generation,granted_generation,grant_request_id FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
      [f.account_id, f.project_id],
    )
  ).rows[0];
  expect(access).toMatchObject({
    generation: f.generation,
    granted_generation: f.generation,
    grant_request_id: newer,
  });
  expect(
    (
      await getPool().query(
        "SELECT entry_key FROM collaboration_index WHERE account_id=$1",
        [f.account_id],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await f.cursor()).cursor).toBe(job.cursor);
  await f.store.fail(job, Error("superseded"));
});

it("invalidates in-flight positive grant replies when acknowledging definitive denial", async () => {
  const f = await fixture();
  await f.run();
  const job = await f.claim();
  const before = await checkCollaborationRevision(f.account_id);
  expect(await f.store.acknowledge(job, { allowed: false })).toBe(true);
  expect(
    await applyCollaborationAccess(
      [
        {
          account_id: f.account_id,
          project_id: f.project_id,
          grant_request_id: job.grant_request_id,
        },
      ],
      [
        {
          account_id: f.account_id,
          project_id: f.project_id,
          generation: f.generation,
        },
      ],
      Date.now(),
    ),
  ).toBe(0);
  const access = (
    await getPool().query(
      "SELECT generation,granted_generation,grant_request_id,lease_until,claim_id,lease_claim_until FROM collaboration_access WHERE account_id=$1 AND project_id=$2",
      [f.account_id, f.project_id],
    )
  ).rows[0];
  expect(access).toMatchObject({
    generation: null,
    granted_generation: null,
    lease_until: null,
    claim_id: null,
    lease_claim_until: null,
  });
  expect(access.grant_request_id).not.toBe(job.grant_request_id);
  expect((await f.cursor()).generation).toBeNull();
  expect(
    (await checkCollaborationRevision(f.account_id, before.revision)).reset,
  ).toBe(true);
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
  expect((await f.cursor()).generation).toBeNull();
  expect(
    (
      await getPool().query(
        "SELECT * FROM collaboration_index WHERE account_id=$1",
        [f.account_id],
      )
    ).rows,
  ).toHaveLength(0);
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

it("reports an expired replay horizon and restarts at the current boundary without a history flood", async () => {
  const f = await fixture();
  await f.run();
  await f.append([f.event(1), f.event(2)]);
  await getPool().query(
    "UPDATE collaboration_notification_events SET created_at=now()-interval '31 days' WHERE project_id=$1",
    [f.project_id],
  );
  expect(await pruneCollaborationNotificationEvents(f.bay)).toBe(2);
  const cursor = await f.cursor();
  const page = await readCollaborationNotificationPage(
    { ...cursor, claim_id: randomUUID() },
    { owning_bay_id: f.bay },
  );
  expect(page).toMatchObject({
    allowed: true,
    reset: true,
    reset_reason: "expired",
    entries: [],
  });
  expect((await f.run()).failed).toBe(0);
  expect((await f.cursor()).last_error).toContain("history expired");
  expect(await f.notifications()).toHaveLength(0);
  await f.append([f.event(3)]);
  await f.run();
  expect(await f.notifications()).toHaveLength(1);
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
