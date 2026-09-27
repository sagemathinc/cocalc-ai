import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { collaboratorsApi, fetchCollaborationAccessBatches } from "./api";
import {
  runCollaboratorsMaintenance,
  runCollaboratorsAccessMaintenance,
} from "./maintenance";
import { syncCollaboratorsSchema } from "@cocalc/database/postgres/collaborators-common";
import { ensureCollaborationNotificationSchema } from "@cocalc/database/postgres/collaborators-notifications";
import { SCHEMA } from "@cocalc/util/db-schema";

// This fixture integrates the SQL owner/home pipeline, not a persist server.
// Keep Favorites explicit and empty instead of implicitly opening an unowned
// Conat connection. Real pin transport is covered by backend/project-pins and
// collaborators/multibay.acceptance.test.ts; neither is mocked there.
let mockPinsRevision = "0";
jest.mock("@cocalc/backend/conat", () => ({
  conat: () => Object.freeze({ sqlFixtureOnly: true }),
}));
jest.mock("@cocalc/backend/collaborators/project-pins", () => ({
  accountProjectPins: () => ({
    read: async () => [],
    revision: async () => mockPinsRevision,
    set: async () => {
      throw Error(
        "SQL collaboration fixture does not implement Favorites writes",
      );
    },
  }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: async () => ({ home_bay_id: mockBayId }),
}));

const mockBayId = `bay-e2e-${randomUUID()}`;
const account_id = randomUUID();
const actor_id = randomUUID();
const project_id = randomUUID();
const host_id = randomUUID();
const previousBay = process.env.COCALC_BAY_ID;
beforeAll(async () => {
  process.env.COCALC_BAY_ID = mockBayId;
  await initEphemeralDatabase();
  await syncCollaboratorsSchema();
  await ensureCollaborationNotificationSchema();
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$3),($2,$3)",
    [account_id, actor_id, mockBayId],
  );
  const users = JSON.stringify({
    [account_id]: { group: "collaborator" },
    [actor_id]: { group: "owner" },
  });
  await getPool().query(
    "INSERT INTO projects(project_id,host_id,owning_bay_id,users) VALUES($1,$2,$4,$3::jsonb)",
    [project_id, host_id, users, mockBayId],
  );
  await getPool().query(
    "INSERT INTO account_project_index(account_id,project_id,owning_bay_id,users_summary,title,sort_key) VALUES($1,$2,$4,$3::jsonb,'Stopped project',now())",
    [account_id, project_id, users, mockBayId],
  );
}, 60000);
afterAll(async () => {
  try {
    const pool = getPool();
    // Real PostgreSQL fixtures persist between Jest runs. Remove only this run's
    // records, including pending work that would otherwise consume bounded claims.
    for (const table of [
      "notification_target_outbox",
      "notification_targets",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE target_account_id=$1`, [
        account_id,
      ]);
    }
    await pool.query(
      "DELETE FROM notification_events WHERE source_project_id=$1",
      [project_id],
    );
    await pool.query("DELETE FROM account_project_index WHERE project_id=$1", [
      project_id,
    ]);
    for (const [table, schema] of Object.entries(SCHEMA)) {
      if (!table.startsWith("collaboration_")) continue;
      if (schema.fields.project_id) {
        await pool.query(`DELETE FROM ${table} WHERE project_id=$1`, [
          project_id,
        ]);
      } else if (schema.fields.account_id) {
        await pool.query(
          `DELETE FROM ${table} WHERE account_id=ANY($1::uuid[])`,
          [[account_id, actor_id]],
        );
      }
    }
    await pool.query("DELETE FROM projects WHERE project_id=$1", [project_id]);
    await pool.query("DELETE FROM accounts WHERE account_id=ANY($1::uuid[])", [
      [account_id, actor_id],
    ]);
  } finally {
    await getPool().end();
    if (previousBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = previousBay;
  }
});

async function maintainUntil(ready: () => Promise<boolean>) {
  // A retained seeding cursor can require another pass before a newly inserted
  // account is visited. Do not make unrelated fixtures due or relax exact counts.
  for (let pass = 0; pass < 5; pass++) {
    for (const table of [
      "collaboration_access",
      "collaboration_notification_cursors",
    ]) {
      await getPool().query(
        `UPDATE ${table} SET due_at=now() WHERE account_id=$1 AND project_id=$2`,
        [account_id, project_id],
      );
    }
    await runCollaboratorsMaintenance();
    if (await ready()) return;
  }
  throw Error("fixture maintenance did not converge after five passes");
}

async function notificationCount() {
  return Number(
    (
      await getPool().query(
        "SELECT count(*) FROM notification_targets WHERE target_account_id=$1",
        [account_id],
      )
    ).rows[0].count,
  );
}

test("canonical message intent reaches the existing notification graph once, then lease revocation clears discovery", async () => {
  const room = await collaboratorsApi.ensureRoom({
    account_id,
    project_id,
    request_id: randomUUID(),
  });
  await collaboratorsApi.markRoomInitialized({
    host_id,
    project_id,
    room_id: room.room_id,
    chat_path: room.chat_path,
    requesting_account_id: account_id,
  });
  const source = { project_id, chat_path: room.chat_path };
  const { epoch } = await collaboratorsApi.registerSource({
    ...source,
    host_id,
    registration_id: randomUUID(),
    expected_epoch: null,
  });
  const resource = {
    ...source,
    kind: "conversation" as const,
    resource_id: "thread",
    thread_id: "thread",
    title: "Live discussion",
    created_at: 1,
    updated_at: 1,
    activity: 1,
    participant_ids: [actor_id],
  };
  await collaboratorsApi.ingest({
    host_id,
    snapshot: { ...source, epoch, sequence: 1, resources: [resource] },
  });
  await maintainUntil(
    async () =>
      (await collaboratorsApi.listResources({ account_id })).items.length > 0,
  );
  const first = await collaboratorsApi.listResources({ account_id });
  expect(first.items).toHaveLength(1);
  expect(
    (await collaboratorsApi.check({ account_id, since: first.revision })).reset,
  ).toBe(false);
  const event = {
    version: 1 as const,
    project_id,
    room_id: room.room_id,
    thread_id: "thread",
    message_id: "new-message",
    actor_account_id: actor_id,
    activity: 2,
    mode: "live" as const,
    mentioned_account_ids: [account_id],
    mention_all: false,
  };
  const snapshot = {
    ...source,
    epoch,
    sequence: 2,
    resources: [{ ...resource, activity: 2, updated_at: 2 }],
    notification_events: [event],
  };
  await collaboratorsApi.ingest({ host_id, snapshot });
  await maintainUntil(async () => (await notificationCount()) >= 1);
  const notifications = await getPool().query(
    `SELECT e.payload_json FROM notification_targets t JOIN notification_events e USING(event_id)
    JOIN notification_target_outbox o USING(notification_id) WHERE t.target_account_id=$1`,
    [account_id],
  );
  expect(notifications.rows).toHaveLength(1);
  expect(notifications.rows[0].payload_json.message_id).toBe(event.message_id);
  expect(
    (await collaboratorsApi.listResources({ account_id, scope: "for-you" }))
      .items[0]?.reason,
  ).toBe("mention");
  expect(
    (await collaboratorsApi.check({ account_id, since: first.revision })).reset,
  ).toBe(true);
  await collaboratorsApi.ingest({ host_id, snapshot });
  await collaboratorsApi.setPersonalState({
    account_id,
    project_id,
    kind: "conversation",
    resource_id: "thread",
    patch: { read_through: 2, following: false, muted: true },
  });
  expect(
    (await collaboratorsApi.listResources({ account_id, scope: "for-you" }))
      .items,
  ).toHaveLength(0);
  const firstLive = {
    ...event,
    thread_id: "brand-new-thread",
    message_id: "first-message",
    activity: 1,
  };
  await collaboratorsApi.ingest({
    host_id,
    snapshot: {
      ...snapshot,
      sequence: 3,
      resources: [
        ...snapshot.resources,
        {
          ...resource,
          resource_id: firstLive.thread_id,
          thread_id: firstLive.thread_id,
          activity: 1,
          updated_at: 3,
        },
      ],
      notification_events: [firstLive],
    },
  });
  await maintainUntil(async () => (await notificationCount()) >= 2);
  expect(
    (
      await getPool().query(
        `SELECT e.payload_json->>'message_id' AS message_id FROM notification_targets t
    JOIN notification_events e USING(event_id) JOIN notification_target_outbox o USING(notification_id)
    WHERE t.target_account_id=$1 ORDER BY message_id`,
        [account_id],
      )
    ).rows,
  ).toEqual([{ message_id: "first-message" }, { message_id: "new-message" }]);
  await getPool().query(
    "UPDATE projects SET users=$2::jsonb WHERE project_id=$1",
    [
      project_id,
      JSON.stringify({
        [actor_id]: { group: "owner" },
        [account_id]: { group: "viewer" },
      }),
    ],
  );
  // Deliberately leave the account project projection stale: the owner grant must win.
  await getPool().query(
    "UPDATE collaboration_access SET lease_due_at=now() WHERE account_id=$1 AND project_id=$2",
    [account_id, project_id],
  );
  const batches = await fetchCollaborationAccessBatches([
    { account_id, project_id, grant_request_id: randomUUID() },
  ]);
  expect(await batches[0].fetch()).toEqual([
    { account_id, project_id, generation: null },
  ]);
  await runCollaboratorsAccessMaintenance();
  expect(
    (await collaboratorsApi.listResources({ account_id })).items,
  ).toHaveLength(0);
  expect(
    (await collaboratorsApi.listProjects({ account_id })).items,
  ).toHaveLength(0);
  await expect(
    collaboratorsApi.listProjectResources({ account_id, project_id }),
  ).rejects.toThrow("access denied");
  await expect(
    collaboratorsApi.roomForHost({
      host_id,
      project_id,
      requesting_account_id: account_id,
    }),
  ).rejects.toThrow("access denied");
}, 30000);

test("the SQL revision still invalidates when the external Favorites revision changes", async () => {
  const before = await collaboratorsApi.check({ account_id });
  expect(
    (await collaboratorsApi.check({ account_id, since: before.revision }))
      .reset,
  ).toBe(false);
  mockPinsRevision = "1";
  const changed = await collaboratorsApi.check({
    account_id,
    since: before.revision,
  });
  expect(changed.reset).toBe(true);
  expect(
    (await collaboratorsApi.check({ account_id, since: changed.revision }))
      .reset,
  ).toBe(false);
});
