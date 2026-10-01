import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import * as notificationCore from "@cocalc/database/postgres/notifications-core";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { reconcileCollaborationAttention } from "@cocalc/util/collaboration-attention";
import { receiveCollaborationMessageNotification } from "./collaboration";
import type {
  CollaborationNotificationDelivery,
  CollaborationNotificationHooks,
} from "./collaboration";

beforeAll(async () => {
  await initEphemeralDatabase();
}, 30000);
afterAll(async () => {
  await getPool().end();
});
afterEach(() => jest.restoreAllMocks());

async function fixture(home_bay_id = getConfiguredBayId()) {
  const account_id = randomUUID();
  await getPool().query(
    "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$2)",
    [account_id, home_bay_id],
  );
  const delivery: CollaborationNotificationDelivery = {
    account_id,
    access_generation: randomUUID(),
    event: {
      version: 1,
      project_id: randomUUID(),
      room_id: randomUUID(),
      thread_id: randomUUID(),
      message_id: randomUUID(),
      actor_account_id: randomUUID(),
      activity: 2,
      mode: "live",
      mentioned_account_ids: [account_id],
      mention_all: false,
    },
  };
  const authority = {
    project_id: delivery.event.project_id,
    room_id: delivery.event.room_id,
    thread_id: delivery.event.thread_id,
    chat_path: "/home/user/.cocalc/collaborators.chat",
    owning_bay_id: "remote-project-owner",
    actor_role: "collaborator",
    recipient_role: "owner",
    access_generation: delivery.access_generation,
  };
  const hooks: CollaborationNotificationHooks = {
    authorize: async () => authority,
    lockAttention: async () => ({
      access_generation: delivery.access_generation,
      state: reconcileCollaborationAttention({
        account_id,
        initial_activity: 1,
      }),
    }),
  };
  return { delivery, hooks, authority };
}

async function rows(account_id: string) {
  return (
    await getPool().query(
      `SELECT e.event_id,e.payload_json,t.notification_id,o.outbox_id,o.published_at,
       o.target_home_bay_id,o.payload_json AS transport
     FROM notification_events e
     JOIN notification_targets t USING(event_id)
     JOIN notification_target_outbox o USING(notification_id)
     WHERE t.target_account_id=$1`,
      [account_id],
    )
  ).rows;
}

it("commits exactly one existing event, target and retryable outbox row across replay and moves", async () => {
  const { delivery, hooks, authority } = await fixture();
  const first = await receiveCollaborationMessageNotification(delivery, hooks);
  expect(first.status).toBe("created");
  authority.chat_path = "/home/user/moved.chat";
  const duplicate = await receiveCollaborationMessageNotification(
    delivery,
    hooks,
  );
  expect(duplicate).toEqual({ ...first, status: "duplicate" });
  const notifications = await rows(delivery.account_id);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    published_at: null,
    target_home_bay_id: getConfiguredBayId(),
    transport: {
      target_account_id: delivery.account_id,
      summary: {
        notification_reason: "mention",
        message_id: delivery.event.message_id,
      },
    },
  });
});

it("rolls back an inserted graph on failure and allows the identical event to retry", async () => {
  const { delivery, hooks } = await fixture();
  const original = notificationCore.createNotificationEventGraphInTransaction;
  jest
    .spyOn(notificationCore, "createNotificationEventGraphInTransaction")
    .mockImplementationOnce(async (opts) => {
      await original(opts);
      throw Error("simulated failure before commit");
    });
  await expect(
    receiveCollaborationMessageNotification(delivery, hooks),
  ).rejects.toThrow("before commit");
  expect(await rows(delivery.account_id)).toHaveLength(0);
  expect(
    (
      await getPool().query(
        "SELECT event_id FROM notification_events WHERE source_project_id=$1",
        [delivery.event.project_id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (await receiveCollaborationMessageNotification(delivery, hooks)).status,
  ).toBe("created");
  expect(await rows(delivery.account_id)).toHaveLength(1);
});

it("uses the real account-home fence instead of trusting the project owner's bay", async () => {
  const { delivery, hooks } = await fixture("another-account-home");
  await expect(
    receiveCollaborationMessageNotification(delivery, hooks),
  ).rejects.toThrow("homed on");
  expect(await rows(delivery.account_id)).toHaveLength(0);
});

(process.env.COCALC_TEST_USE_PGLITE ? it.skip : it)(
  "serializes simultaneous receivers at the database fence",
  async () => {
    const { delivery, hooks } = await fixture();
    const results = await Promise.all([
      receiveCollaborationMessageNotification(delivery, hooks),
      receiveCollaborationMessageNotification(delivery, hooks),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "duplicate",
    ]);
    expect(await rows(delivery.account_id)).toHaveLength(1);
  },
);
