/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { getPeopleInvitationService } from "./invitations-runtime";
import { executePeopleInvitationAccess } from "@cocalc/server/people/invitation-actions";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { drainAccountNotificationIndexProjection } from "@cocalc/database/postgres/account-notification-index-projector";
import {
  getProjectedNotificationCounts,
  setProjectedNotificationReadState,
} from "@cocalc/database/postgres/account-notification-index";
import {
  listInvitationHistoryLocal,
  applyAccessProjection,
} from "@cocalc/server/people/invite-projections";
import { drainPeopleCollaborationOutbox } from "@cocalc/server/people/collaboration-projections";
import type { PeopleInvitationPayload } from "@cocalc/util/people-invitations";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { peopleCollaborationInvitationId } from "./invitations-identity";

jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: async () => Buffer.alloc(32, 7),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountsByIds: jest.fn(async (account_ids: string[]) =>
    account_ids.map((account_id) => ({
      account_id,
      home_bay_id: process.env.COCALC_BAY_ID,
      first_name: "Test",
      last_name: "Recipient",
    })),
  ),
  getClusterAccountById: jest.fn(async (account_id) => ({
    account_id,
    home_bay_id: process.env.COCALC_BAY_ID,
  })),
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: jest.fn(async () => ({
    home_bay_id: process.env.COCALC_BAY_ID,
  })),
}));
jest.mock("@cocalc/server/cluster-config", () => ({
  isMultiBayCluster: () => false,
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: async () => ({
    bay_id: process.env.COCALC_BAY_ID,
    epoch: 1,
  }),
}));
jest.mock("@cocalc/database/postgres/account-rehome-fence", () =>
  jest.requireActual("../../database/postgres/account-rehome-fence"),
);
jest.mock("@cocalc/server/people/invitation-actions", () => ({
  preflightPeopleInvitationAction: jest.fn(
    async (_account, payload, action) => ({
      project_id: action.project_id,
      action: action.action,
      recipient_access:
        payload.recipient.kind === "email"
          ? "unknown"
          : action.action === "notify"
            ? "sufficient"
            : "insufficient",
      warnings: [],
    }),
  ),
  inspectPeopleInvitationAccess: jest.fn(async () => undefined),
  executePeopleInvitationAccess: jest.fn(async (input) => ({
    child_operation_id: input.child_operation_id,
    project_id: input.action.project_id,
    action: input.action.action,
    status: "created",
    access_invite_id: input.child_operation_id,
    delivery: [{ channel: "email", status: "sent" }],
  })),
}));

const describeDb =
  process.env.COCALC_TEST_USE_PGLITE === "1" ? describe : describe.skip;
describeDb("people runtime notification/contact/history bridge", () => {
  const oldBay = process.env.COCALC_BAY_ID;
  let sender: string, recipient: string, projects: string[];
  beforeAll(async () => {
    process.env.COCALC_BAY_ID = "invitation-runtime-test";
    await initEphemeralDatabase();
  }, 30000);
  beforeEach(async () => {
    jest.clearAllMocks();
    sender = randomUUID();
    recipient = randomUUID();
    projects = [randomUUID(), randomUUID()];
    await getPool().query(
      "INSERT INTO accounts(account_id,home_bay_id) VALUES($1,$3),($2,$3)",
      [sender, recipient, getConfiguredBayId()],
    );
    for (const project_id of projects)
      await getPool().query(
        "INSERT INTO projects(project_id,owning_bay_id) VALUES($1,$2)",
        [project_id, getConfiguredBayId()],
      );
  });
  afterAll(async () => {
    if (oldBay === undefined) delete process.env.COCALC_BAY_ID;
    else process.env.COCALC_BAY_ID = oldBay;
    await getPool().end();
  });
  const payload = (): PeopleInvitationPayload => ({
    recipient: { kind: "account", account_id: recipient },
    projects: projects.map((project_id) => ({ project_id, action: "notify" })),
    message: "Please collaborate",
    channels: { notification: true, email: false },
  });
  async function send(p = payload()) {
    const service = getPeopleInvitationService();
    const draft = await service.prepare(
      sender,
      { draft_id: randomUUID(), expected_revision: 0, payload: p },
      "verified",
    );
    const review = await service.review(sender, draft, "verified");
    const input = {
      draft_id: draft.draft_id,
      revision: draft.revision,
      review_id: review.review_id,
      idempotency_key: randomUUID(),
    };
    return { input, operation: await service.send(sender, input, "verified") };
  }
  async function project() {
    await drainAccountNotificationIndexProjection({
      bay_id: getConfiguredBayId(),
      limit: 100,
      dry_run: false,
    });
    await drainPeopleCollaborationOutbox();
  }
  it("creates one consolidated notice, durable per-project history and one contact, without access offers", async () => {
    const { operation, input } = await send();
    expect(operation.status).toBe("complete");
    expect(executePeopleInvitationAccess).not.toHaveBeenCalled();
    const records = (
      await getPool().query(
        "SELECT event_id FROM notification_events WHERE actor_account_id=$1",
        [sender],
      )
    ).rows;
    expect(records).toHaveLength(1);
    expect(
      (
        await getPool().query(
          "SELECT * FROM project_collab_invites WHERE inviter_account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await getPool().query(
          "SELECT * FROM people_contacts WHERE account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(1);
    await project();
    const status = await getPeopleInvitationService().status(
      sender,
      operation.operation_id,
      "verified",
    );
    for (const outcome of status.outcomes)
      expect(
        outcome.delivery.find((d) => d.channel === "notification")?.status,
      ).toBe("sent");
    const received = await listInvitationHistoryLocal({
      account_id: recipient,
      view: "received",
      kind: "collaboration",
    });
    expect(received.items).toHaveLength(2);
    expect(
      await getProjectedNotificationCounts({ account_id: recipient }),
    ).toMatchObject({ total: 1, unread: 1 });
    const notice = status.outcomes[0].delivery.find(
      (d) => d.channel === "notification",
    )!.receipt_id!;
    await setProjectedNotificationReadState({
      account_id: recipient,
      notification_ids: [notice],
      read: true,
    });
    await getPeopleInvitationService().send(sender, input, "verified");
    await project();
    expect(
      await getProjectedNotificationCounts({ account_id: recipient }),
    ).toMatchObject({ total: 1, unread: 0 });
    const senderResult = await getPeopleInvitationService().status(
      sender,
      operation.operation_id,
      "verified",
    );
    expect(JSON.stringify(senderResult)).not.toContain("notification_read");
    expect(
      (
        await getPool().query(
          "SELECT event_id FROM notification_events WHERE actor_account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("keeps access and collaboration projections distinct for the same operation", async () => {
    jest
      .mocked(executePeopleInvitationAccess)
      .mockImplementationOnce(async (input) => {
        const timestamp = new Date().toISOString();
        for (const account_id of [sender, recipient])
          await applyAccessProjection({
            account_id,
            source_bay_id: getConfiguredBayId(),
            source_epoch: 1,
            deleted: false,
            invitation: {
              invitation_id: input.child_operation_id,
              kind: "access",
              project_id: input.action.project_id,
              sender_account_id: sender,
              recipient_account_id: recipient,
              person_id: null,
              accepted_account_id: null,
              status: "pending",
              role: "collaborator",
              read_policy: null,
              message: input.payload.message,
              invite_source: "account",
              scope: null,
              created_at: timestamp,
              updated_at: timestamp,
              expires_at: null,
              responded_at: null,
              last_sent_at: null,
              resend_count: 0,
              source_version: "1",
              source_bay_id: getConfiguredBayId(),
            },
          });
        return {
          child_operation_id: input.child_operation_id,
          project_id: input.action.project_id,
          action: input.action.action,
          status: "created",
          access_invite_id: input.child_operation_id,
          delivery: [],
        };
      });
    const { operation, input } = await send({
      ...payload(),
      projects: [
        {
          project_id: projects[0],
          action: "offer_access",
          role: "collaborator",
        },
      ],
    });
    const outcome = operation.outcomes[0];
    const collaboration_id = peopleCollaborationInvitationId(
      operation.operation_id,
      outcome.child_operation_id,
    );
    expect(outcome.access_invite_id).toBe(outcome.child_operation_id);
    expect(outcome.collaboration_invitation_id).toBe(collaboration_id);
    expect(collaboration_id).not.toBe(outcome.access_invite_id);
    await project();
    for (const account_id of [sender, recipient]) {
      const page = await listInvitationHistoryLocal({
        account_id,
        view: account_id === sender ? "sent" : "received",
      });
      expect(page.items.map((i) => i.kind).sort()).toEqual([
        "access",
        "collaboration",
      ]);
      expect(new Set(page.items.map((i) => i.invitation_id)).size).toBe(2);
    }
    const notice = (
      await getPool().query(
        "SELECT payload_json FROM notification_events WHERE actor_account_id=$1",
        [sender],
      )
    ).rows[0].payload_json;
    expect(notice.invitation_id).toBe(collaboration_id);
    expect(notice.access_invite_ids).toEqual([outcome.access_invite_id]);
    const replay = await getPeopleInvitationService().send(
      sender,
      input,
      "verified",
    );
    expect(replay.outcomes[0].collaboration_invitation_id).toBe(
      collaboration_id,
    );
    expect(executePeopleInvitationAccess).toHaveBeenCalledTimes(1);
  });
  it("does not attach an in-app receipt for email-only account delivery", async () => {
    const { operation } = await send({
      ...payload(),
      channels: { notification: false, email: true },
    });
    for (const outcome of operation.outcomes) {
      expect(
        outcome.delivery.find((d) => d.channel === "notification"),
      ).toMatchObject({ status: "suppressed" });
      expect(
        outcome.delivery.find((d) => d.channel === "notification")?.receipt_id,
      ).toBeUndefined();
      expect(
        outcome.delivery.find((d) => d.channel === "email")?.receipt_id,
      ).toBeTruthy();
    }
    await project();
    expect(
      await getProjectedNotificationCounts({ account_id: recipient }),
    ).toMatchObject({ total: 0, unread: 0 });
    const stored = (
      await getPool().query(
        "SELECT invitation FROM people_invitation_index WHERE account_id=$1",
        [sender],
      )
    ).rows;
    expect(stored.every((r) => r.invitation.notification_id == null)).toBe(
      true,
    );
  });
  it("refreshes explicit preference suppression instead of reporting queued forever", async () => {
    await getPool().query(
      "UPDATE accounts SET other_settings=$2::jsonb WHERE account_id=$1",
      [
        recipient,
        JSON.stringify({
          notification_preferences: { email: { mentions: "none" } },
        }),
      ],
    );
    const { operation } = await send();
    await project();
    const status = await getPeopleInvitationService().status(
      sender,
      operation.operation_id,
      "verified",
    );
    for (const outcome of status.outcomes)
      expect(
        outcome.delivery.find((d) => d.channel === "notification"),
      ).toMatchObject({
        status: "suppressed",
        reason: "notification_preference",
      });
    expect(
      await getProjectedNotificationCounts({ account_id: recipient }),
    ).toMatchObject({ total: 0, unread: 0 });
  });
  it("keeps an email recipient private and account-free while recording durable owner email evidence", async () => {
    const email_address = "new-person@example.test";
    const { operation } = await send({
      recipient: { kind: "email", email_address },
      projects: [
        {
          project_id: projects[0],
          action: "offer_access",
          role: "collaborator",
        },
      ],
      message: "Email invite",
      channels: { notification: false, email: true },
    });
    expect(operation.status).toBe("complete");
    expect(
      operation.outcomes[0].delivery.find((d) => d.channel === "email")?.status,
    ).toBe("sent");
    const contacts = (
      await getPool().query(
        "SELECT * FROM people_contacts WHERE account_id=$1",
        [sender],
      )
    ).rows;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].linked_account_id).toBeNull();
    expect(JSON.stringify(contacts)).not.toContain(email_address);
    expect(
      jest
        .mocked(getClusterAccountById)
        .mock.calls.every(([id]) => id === sender),
    ).toBe(true);
    expect(
      (
        await getPool().query(
          "SELECT event_id FROM notification_events WHERE actor_account_id=$1",
          [sender],
        )
      ).rows,
    ).toHaveLength(0);
  });
});
