import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import {
  getProjectedNotificationCounts,
  setProjectedNotificationReadState,
  setProjectedNotificationArchivedState,
} from "@cocalc/database/postgres/account-notification-index";
import { drainAccountNotificationIndexProjection } from "@cocalc/database/postgres/account-notification-index-projector";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { queueContentInvitationNotification } from "./content-invitation";
import type { ContentInvitationNotificationInput } from "./content-invitation";

beforeAll(async () => {
  await initEphemeralDatabase();
}, 30000);
afterAll(async () => {
  await getPool().end();
});

async function fixture() {
  const sender_account_id = randomUUID();
  const recipient_account_id = randomUUID();
  await getPool().query(
    `INSERT INTO accounts(account_id, home_bay_id)
     VALUES ($1,$3),($2,$3)`,
    [sender_account_id, recipient_account_id, getConfiguredBayId()],
  );
  const input: Omit<ContentInvitationNotificationInput, "db"> = {
    sender_account_id,
    recipient_account_id,
    recipient_home_bay_id: getConfiguredBayId(),
    operation_id: randomUUID(),
    invitation_id: randomUUID(),
    message: "Please look at my notebook.",
    channels: { notification: true, email: false },
  };
  const send = (rollback = false) =>
    withAccountRehomeWriteFence({
      account_id: sender_account_id,
      action: "queue content invitation",
      fn: async (db) => {
        const result = await queueContentInvitationNotification({
          db,
          ...input,
        });
        if (rollback) throw Error("simulate operation receipt failure");
        return result;
      },
    });
  const drain = () =>
    drainAccountNotificationIndexProjection({
      bay_id: getConfiguredBayId(),
      limit: 100,
      dry_run: false,
    });
  return { input, send, drain };
}

it("uses real notification unread/read/archive counts without creating any access invite", async () => {
  const { input, send, drain } = await fixture();
  const first = await send();
  if (first.status !== "queued") throw Error("expected queued notice");
  await drain();
  const account_id = input.recipient_account_id;
  expect(await getProjectedNotificationCounts({ account_id })).toMatchObject({
    total: 1,
    unread: 1,
  });
  await setProjectedNotificationReadState({
    account_id,
    notification_ids: [first.notification_id],
    read: true,
  });
  expect(await send()).toEqual({ ...first, status: "duplicate" });
  await drain();
  expect(await getProjectedNotificationCounts({ account_id })).toMatchObject({
    total: 1,
    unread: 0,
  });
  await setProjectedNotificationArchivedState({
    account_id,
    notification_ids: [first.notification_id],
    archived: true,
  });
  await send();
  await drain();
  expect(await getProjectedNotificationCounts({ account_id })).toMatchObject({
    unread: 0,
    archived: 1,
  });
  const { rows } = await getPool().query(
    "SELECT status FROM notification_email_outbox WHERE notification_id=$1",
    [first.notification_id],
  );
  expect(rows).toEqual([{ status: "skipped_preference" }]);
  const invites = await getPool().query(
    "SELECT invite_id FROM project_collab_invites WHERE inviter_account_id=$1",
    [input.sender_account_id],
  );
  expect(invites.rows).toEqual([]);
});

it("rolls the graph and delivery outbox back with the caller's operation receipt", async () => {
  const { input, send, drain } = await fixture();
  await expect(send(true)).rejects.toThrow("receipt failure");
  const { rows } = await getPool().query(
    "SELECT event_id FROM notification_events WHERE actor_account_id=$1",
    [input.sender_account_id],
  );
  expect(rows).toEqual([]);
  expect((await send()).status).toBe("queued");
  await drain();
  expect(
    await getProjectedNotificationCounts({
      account_id: input.recipient_account_id,
    }),
  ).toMatchObject({ total: 1, unread: 1 });
});

it("honors recipient none preferences without manufacturing unread entries", async () => {
  const { input, send, drain } = await fixture();
  await getPool().query(
    "UPDATE accounts SET other_settings=$2::jsonb WHERE account_id=$1",
    [
      input.recipient_account_id,
      JSON.stringify({
        notification_preferences: { email: { mentions: "none" } },
      }),
    ],
  );
  expect((await send()).status).toBe("queued");
  await drain();
  expect(
    await getProjectedNotificationCounts({
      account_id: input.recipient_account_id,
    }),
  ).toMatchObject({ total: 0, unread: 0 });
});

it("queues email-only delivery without an in-app count or a pretend dismissal", async () => {
  const { input, send, drain } = await fixture();
  input.channels = { notification: false, email: true };
  await getPool().query(
    "UPDATE accounts SET email_address=$2 WHERE account_id=$1",
    [input.recipient_account_id, `${input.recipient_account_id}@example.test`],
  );
  const result = await send();
  if (result.status !== "queued") throw Error("expected queued notice");
  await drain();
  expect(
    await getProjectedNotificationCounts({
      account_id: input.recipient_account_id,
    }),
  ).toMatchObject({ total: 0, unread: 0 });
  expect(
    await setProjectedNotificationArchivedState({
      account_id: input.recipient_account_id,
      notification_ids: [result.notification_id],
      archived: true,
    }),
  ).toMatchObject({ updated_count: 0 });
  const { rows } = await getPool().query(
    "SELECT status, responsible_account_id, lane FROM notification_email_outbox WHERE notification_id=$1",
    [result.notification_id],
  );
  expect(rows).toEqual([
    {
      status: "queued",
      responsible_account_id: input.sender_account_id,
      lane: "notification",
    },
  ]);
});

it("does not let a sender mark or dismiss the recipient notification", async () => {
  const { input, send, drain } = await fixture();
  const result = await send();
  if (result.status !== "queued") throw Error("expected queued notice");
  await drain();
  for (const mutate of [
    setProjectedNotificationReadState,
    setProjectedNotificationArchivedState,
  ]) {
    expect(
      await mutate({
        account_id: input.sender_account_id,
        notification_ids: [result.notification_id],
        read: true,
        archived: true,
      }),
    ).toMatchObject({ updated_count: 0 });
  }
  expect(
    await getProjectedNotificationCounts({
      account_id: input.recipient_account_id,
    }),
  ).toMatchObject({ total: 1, unread: 1 });
});
