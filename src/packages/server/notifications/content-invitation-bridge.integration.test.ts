/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
import { drainAccountNotificationIndexProjection } from "@cocalc/database/postgres/account-notification-index-projector";
import {
  getProjectedNotificationCounts,
  setProjectedNotificationReadState,
  setProjectedNotificationArchivedState,
} from "@cocalc/database/postgres/account-notification-index";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { ensurePeopleSchema } from "@cocalc/server/people/schema";
import {
  recordPeopleInvitationOperation,
  drainPeopleCollaborationOutbox,
} from "@cocalc/server/people/collaboration-projections";
import {
  listInvitationHistoryLocal,
  getPeopleInvitationCountsLocal,
} from "@cocalc/server/people/invite-projections";
import type { PeopleInvitationOperation } from "@cocalc/util/people-invitations";
import { queueContentInvitationNotification } from "./content-invitation";
import { readContentInvitationDeliveryOnHomeBay } from "./content-invitation-delivery";
import { sendQueuedNotificationEmailBatch } from "./email-outbox-maintenance";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
jest.mock("@cocalc/database/settings", () => ({
  getServerSettings: async () => ({
    help_email: "help@example.test",
    site_name: "Test",
  }),
}));
jest.mock("@cocalc/server/hub/site-url", () => ({
  __esModule: true,
  default: async (path: string) => `https://example.test/${path}`,
}));
jest.mock("@cocalc/server/projects/collaborators", () => ({
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: jest.fn(async (account_id) => ({
    account_id,
    home_bay_id: process.env.COCALC_BAY_ID || "bay-0",
    first_name: "Synthetic",
    last_name: "Collaborator",
  })),
  getClusterAccountsByIds: jest.fn(async (account_ids: string[]) =>
    account_ids.map((account_id) => ({
      account_id,
      home_bay_id: process.env.COCALC_BAY_ID || "bay-0",
      first_name: "Synthetic",
      last_name: "Collaborator",
    })),
  ),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => false,
}));

beforeAll(async () => {
  await initEphemeralDatabase();
  await ensurePeopleSchema();
}, 30000);
afterAll(async () => {
  await getPool().end();
});

async function fixture(projects = 1, email = false) {
  const sender = randomUUID(),
    recipient = randomUUID();
  const bay = getConfiguredBayId();
  await getPool().query(
    `INSERT INTO accounts(account_id,home_bay_id,email_address)
     VALUES($1,$3,NULL),($2,$3,$4)`,
    [sender, recipient, bay, `${recipient}@example.test`],
  );
  const membership = {
    [sender]: { group: "owner" },
    [recipient]: { group: "collaborator" },
  };
  const projectIds: string[] = [];
  for (let i = 0; i < projects; i++) {
    const project_id = randomUUID();
    projectIds.push(project_id);
    await getPool().query(
      "INSERT INTO projects(project_id,users) VALUES($1,$2::jsonb)",
      [project_id, JSON.stringify(membership)],
    );
  }
  const operation: PeopleInvitationOperation = {
    operation_id: randomUUID(),
    account_id: sender,
    draft_id: randomUUID(),
    revision: 1,
    payload: {
      recipient: { kind: "account", account_id: recipient },
      projects: projectIds.map((project_id) => ({
        project_id,
        action: "notify",
      })),
      message: "Please review this notebook; do not run it.",
      channels: { notification: true, email },
    },
    status: "complete",
    outcomes: projectIds.map((project_id) => {
      const child_operation_id = randomUUID();
      return {
        child_operation_id,
        collaboration_invitation_id: child_operation_id,
        project_id,
        action: "notify",
        status: "notified",
        delivery: [],
      };
    }),
    created_at: Date.now(),
    updated_at: Date.now(),
    source_version: 1,
    authorization_expires_at: Date.now() + 60000,
  };
  const queue = () =>
    withAccountRehomeWriteFence({
      account_id: sender,
      action: "commit synthetic reviewed notification",
      fn: async (db) => {
        const result = await queueContentInvitationNotification({
          db,
          operation_id: operation.operation_id,
          invitation_id: operation.outcomes[0].collaboration_invitation_id!,
          sender_account_id: sender,
          recipient_account_id: recipient,
          recipient_home_bay_id: bay,
          project_id: projectIds[0],
          message: operation.payload.message,
          channels: operation.payload.channels,
        });
        if (result.status === "suppressed")
          throw Error("expected queued intent");
        for (const outcome of operation.outcomes) {
          outcome.delivery = [
            {
              channel: "notification",
              status: operation.payload.channels.notification
                ? "queued"
                : "suppressed",
              ...(operation.payload.channels.notification
                ? { receipt_id: result.notification_id }
                : {}),
            },
            {
              channel: "email",
              status: email ? "queued" : "suppressed",
              ...(email ? { receipt_id: result.notification_id } : {}),
            },
          ];
        }
        return result;
      },
    });
  const drain = () =>
    drainAccountNotificationIndexProjection({
      bay_id: bay,
      limit: 100,
      dry_run: false,
    });
  const project = async () => {
    await recordPeopleInvitationOperation(operation);
    await drainPeopleCollaborationOutbox();
  };
  const received = () =>
    listInvitationHistoryLocal({
      account_id: recipient,
      view: "received",
      kind: "collaboration",
    });
  const delivery = (notification_id: string, sender_account_id = sender) =>
    readContentInvitationDeliveryOnHomeBay({
      recipient_account_id: recipient,
      sender_account_id,
      notification_ids: [notification_id],
    });
  return {
    sender,
    recipient,
    projectIds,
    membership,
    operation,
    queue,
    drain,
    project,
    received,
    delivery,
  };
}

it("delivers existing-collaborator intent through the real DB graph and history bridge with no access invite", async () => {
  const f = await fixture();
  const notice = await f.queue();
  await f.project();
  expect((await f.received()).unread).toBeNull(); // delivery has not projected yet
  await f.drain();
  const received = await f.received();
  expect(received).toMatchObject({
    total: 1,
    unread: 1,
    pending: { sent: 0, received: 0 },
  });
  expect(received.items[0]).toMatchObject({
    notification_id: notice.notification_id,
    notification_read: false,
    notification_archived: false,
    message: f.operation.payload.message,
    delivery: [
      {
        channel: "notification",
        status: "sent",
        receipt_id: notice.notification_id,
      },
      { channel: "email", status: "suppressed" },
    ],
  });
  expect(await f.delivery(notice.notification_id)).toEqual([
    {
      notification_id: notice.notification_id,
      delivery: [
        {
          channel: "notification",
          status: "sent",
          receipt_id: notice.notification_id,
        },
        {
          channel: "email",
          status: "suppressed",
          reason: "notification_preference",
          receipt_id: notice.notification_id,
        },
      ],
    },
  ]);
  await setProjectedNotificationReadState({
    account_id: f.recipient,
    notification_ids: [notice.notification_id],
    read: true,
  });
  expect((await f.received()).unread).toBe(0);
  const afterRead = await f.delivery(notice.notification_id);
  await setProjectedNotificationArchivedState({
    account_id: f.recipient,
    notification_ids: [notice.notification_id],
    archived: true,
  });
  expect((await f.received()).total).toBe(0);
  const history = await listInvitationHistoryLocal({
    account_id: f.recipient,
    view: "history",
  });
  expect(history.items[0]).toMatchObject({
    notification_read: true,
    notification_archived: true,
  });
  expect(await f.delivery(notice.notification_id)).toEqual(afterRead); // no engagement leak
  expect(
    (await listInvitationHistoryLocal({ account_id: f.sender })).items[0],
  ).toMatchObject({
    notification_read: null,
    notification_archived: null,
  });
  expect(
    (
      await getPool().query("SELECT users FROM projects WHERE project_id=$1", [
        f.projectIds[0],
      ])
    ).rows[0].users,
  ).toEqual(f.membership);
  expect(
    (
      await getPool().query(
        "SELECT invite_id FROM project_collab_invites WHERE inviter_account_id=$1",
        [f.sender],
      )
    ).rows,
  ).toEqual([]);
});

it("counts one consolidated multi-project notice, and archive dismisses all linked rows without affecting access", async () => {
  const f = await fixture(2);
  const notice = await f.queue();
  await f.project();
  await f.drain();
  expect(await f.received()).toMatchObject({ total: 2, unread: 1 });
  expect(
    await getProjectedNotificationCounts({ account_id: f.recipient }),
  ).toMatchObject({ total: 1, unread: 1 });
  expect(
    await getPeopleInvitationCountsLocal({ account_id: f.recipient }),
  ).toMatchObject({ unread: 1, pending: { sent: 0, received: 0 } });
  await setProjectedNotificationArchivedState({
    account_id: f.recipient,
    notification_ids: [notice.notification_id],
    archived: true,
  });
  expect((await f.queue()).status).toBe("duplicate");
  await f.project();
  await f.drain();
  expect(await f.received()).toMatchObject({ total: 0, unread: 0 });
  expect(
    await listInvitationHistoryLocal({
      account_id: f.recipient,
      view: "history",
    }),
  ).toMatchObject({ total: 2, unread: 0 });
  expect(
    (
      await getPool().query(
        "SELECT users FROM projects WHERE project_id=ANY($1::uuid[])",
        [f.projectIds],
      )
    ).rows.map((r) => r.users),
  ).toEqual([f.membership, f.membership]);
});

it.each(["sent", "failed", "suppressed"] as const)(
  "observes eventual email %s instead of the queued admission receipt",
  async (status) => {
    const f = await fixture(1, true);
    const notice = await f.queue();
    await f.project();
    await f.drain();
    expect(
      (await f.delivery(notice.notification_id))[0].delivery[1].status,
    ).toBe("queued");
    const sender = jest.fn(async () => {
      if (status === "failed")
        throw Error("private provider diagnostics must not escape");
    });
    await sendQueuedNotificationEmailBatch({
      sender,
      emailConfigured: async () => status !== "suppressed",
      sendLimitChecker: async () => ({ allowed: true }) as any,
    });
    const observed = await f.delivery(notice.notification_id);
    expect(observed[0].delivery[1].status).toBe(status);
    expect((await f.received()).items[0].delivery).toEqual(
      observed[0].delivery,
    );
    expect(JSON.stringify(observed)).not.toContain("private provider");
    expect(JSON.stringify(observed)).not.toContain("@example.test");
    expect(
      (await f.delivery(notice.notification_id, randomUUID()))[0].delivery.map(
        (r) => r.status,
      ),
    ).toEqual(["unknown", "unknown"]);
  },
);

it("records preference suppression without leaving receipts queued or unread unknown", async () => {
  const f = await fixture(1, true);
  await getPool().query(
    "UPDATE accounts SET other_settings=$2::jsonb WHERE account_id=$1",
    [
      f.recipient,
      JSON.stringify({
        notification_preferences: { email: { mentions: "none" } },
      }),
    ],
  );
  const notice = await f.queue();
  await f.project();
  expect((await f.received()).unread).toBeNull();
  await f.drain();
  const receipts = (await f.delivery(notice.notification_id))[0].delivery;
  expect(receipts).toEqual(
    ["notification", "email"].map((channel) => ({
      channel,
      receipt_id: notice.notification_id,
      status: "suppressed",
      reason: "notification_preference",
    })),
  );
  const history = await f.received();
  expect(history).toMatchObject({
    total: 1,
    unread: 0,
    pending: { sent: 0, received: 0 },
  });
  expect(history.items[0].delivery).toEqual(receipts);
  expect(
    await getProjectedNotificationCounts({ account_id: f.recipient }),
  ).toMatchObject({ total: 0, unread: 0 });
  expect(
    await setProjectedNotificationArchivedState({
      account_id: f.recipient,
      notification_ids: [notice.notification_id],
      archived: true,
    }),
  ).toMatchObject({ updated_count: 0 });
});

it("keeps email-only history outside notification unread and dismiss counts", async () => {
  const f = await fixture(1, true);
  f.operation.payload.channels.notification = false;
  const notice = await f.queue();
  await f.project();
  await f.drain();
  const history = await f.received();
  expect(history).toMatchObject({ total: 1, unread: 0 });
  expect(history.items[0]).toMatchObject({
    notification_id: null,
    delivery: [
      { channel: "notification", status: "suppressed" },
      {
        channel: "email",
        status: "queued",
        receipt_id: notice.notification_id,
      },
    ],
  });
  expect(
    await setProjectedNotificationArchivedState({
      account_id: f.recipient,
      notification_ids: [notice.notification_id],
      archived: true,
    }),
  ).toMatchObject({ updated_count: 0 });
});

it("requires the recipient home for receipt lookup instead of reading a local shadow", async () => {
  const f = await fixture();
  const notice = await f.queue();
  await f.drain();
  await getPool().query(
    "UPDATE accounts SET home_bay_id='other-recipient-home' WHERE account_id=$1",
    [f.recipient],
  );
  await expect(f.delivery(notice.notification_id)).rejects.toThrow("homed on");
});
