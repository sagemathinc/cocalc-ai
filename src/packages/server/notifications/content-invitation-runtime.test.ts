import { getPeopleInvitationService } from "@cocalc/server/collaborators/invitations-runtime";
import { PeopleInvitationService } from "@cocalc/server/collaborators/invitations";
import type { PeopleInvitationServices } from "@cocalc/server/collaborators/invitations";
import type { PeopleInvitationOperation } from "@cocalc/util/people-invitations";
import type { PoolClient } from "@cocalc/database/pool";
import { createNotificationEventGraphInTransaction } from "@cocalc/database/postgres/notifications-core";
import { preflightPeopleInvitationAction } from "@cocalc/server/people/invitation-actions";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}));
jest.mock("@cocalc/database/settings/secret-settings", () => ({
  getSecretSettingsKey: jest.fn(),
}));
jest.mock("@cocalc/util/secret-settings-crypto", () => ({
  encryptSecretSettingValue: jest.fn(),
  decryptSecretSettingValue: jest.fn(),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "sender-home",
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(),
}));
jest.mock("@cocalc/server/people/common", () => ({ peopleHome: jest.fn() }));
jest.mock("@cocalc/server/people/api", () => ({
  getPeopleContact: jest.fn(),
  ensurePeopleContact: jest.fn(),
}));
jest.mock("@cocalc/server/people/collaboration-projections", () => ({
  recordPeopleInvitationOperation: jest.fn(),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: jest.fn(async () => ({
    home_bay_id: "recipient-home",
  })),
}));
// The owner authorization boundary is intentionally mocked; these tests exercise
// the production service adapter -> real notification helper -> graph boundary.
jest.mock("@cocalc/server/people/invitation-actions", () => ({
  preflightPeopleInvitationAction: jest.fn(),
  inspectPeopleInvitationAccess: jest.fn(),
  executePeopleInvitationAccess: jest.fn(),
}));
jest.mock("@cocalc/server/collaborators/invitations-store", () => ({
  PeopleInvitationStore: jest.fn(),
}));
jest.mock("@cocalc/server/collaborators/invitations", () => ({
  PeopleInvitationService: jest.fn(),
  invitationReviewRequired: () => Error("review required"),
}));
jest.mock("@cocalc/database/postgres/notifications-core", () => ({
  createNotificationEventGraphInTransaction: jest.fn(),
}));

const project_id = "11111111-1111-4111-8111-111111111111";
let services: PeopleInvitationServices;
let db: PoolClient;
let operation: PeopleInvitationOperation;
beforeAll(() => {
  getPeopleInvitationService();
  services = (PeopleInvitationService as unknown as jest.Mock).mock.calls[0][1];
});
beforeEach(() => {
  jest.clearAllMocks();
  db = { query: jest.fn(async () => ({ rows: [] })) } as unknown as PoolClient;
  (preflightPeopleInvitationAction as jest.Mock).mockImplementation(
    async (_account, _payload, action) => ({
      project_id: action.project_id,
      action: action.action,
      recipient_access: "sufficient",
      warnings: [],
    }),
  );
  operation = {
    operation_id: "22222222-2222-4222-8222-222222222222",
    account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    draft_id: "33333333-3333-4333-8333-333333333333",
    revision: 1,
    payload: {
      recipient: {
        kind: "account",
        account_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      projects: [{ project_id, action: "notify" }],
      message: "Please look at this",
      channels: { notification: true, email: false },
    },
    status: "complete",
    created_at: 1,
    updated_at: 1,
    source_version: 1,
    authorization_expires_at: Date.now() + 60000,
    outcomes: [
      {
        child_operation_id: "44444444-4444-4444-8444-444444444444",
        project_id,
        action: "notify",
        status: "notified",
        delivery: [],
      },
    ],
  };
});

it("wires notify-only sends to the graph and records the actual returned notification ID", async () => {
  const deliver = await services.prepareDelivery(operation);
  expect(db.query).not.toHaveBeenCalled();
  await deliver(db, operation);
  const event = (createNotificationEventGraphInTransaction as jest.Mock).mock
    .calls[0][0].input;
  expect(event.payload_json.access_invite_ids).toEqual([]);
  expect(event.targets[0].target_home_bay_id).toBe("recipient-home");
  expect(operation.outcomes[0].delivery).toContainEqual({
    channel: "notification",
    status: "queued",
    receipt_id: event.targets[0].notification_id,
  });
  expect(operation.outcomes[0].delivery).toContainEqual({
    channel: "email",
    status: "suppressed",
  });
});

it("consolidates content plus access projects into one notice and shared history identity", async () => {
  const secondProject = "55555555-5555-4555-8555-555555555555";
  const accessInvite = "66666666-6666-4666-8666-666666666666";
  operation.payload.projects.push({
    project_id: secondProject,
    action: "offer_access",
    role: "collaborator",
  });
  operation.outcomes.push({
    child_operation_id: "77777777-7777-4777-8777-777777777777",
    project_id: secondProject,
    action: "offer_access",
    status: "created",
    access_invite_id: accessInvite,
    delivery: [],
  });
  await (
    await services.prepareDelivery(operation)
  )(db, operation);
  const graph = createNotificationEventGraphInTransaction as jest.Mock;
  expect(graph).toHaveBeenCalledTimes(1);
  expect(graph.mock.calls[0][0].input.payload_json.access_invite_ids).toEqual([
    accessInvite,
  ]);
  const ids = operation.outcomes.map(
    (outcome) =>
      outcome.delivery.find((r) => r.channel === "notification")?.receipt_id,
  );
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBe(ids[0]);
});

it("requires review instead of notifying or granting access after recipient access loss", async () => {
  (preflightPeopleInvitationAction as jest.Mock).mockResolvedValue({
    project_id,
    action: "notify",
    recipient_access: "insufficient",
    warnings: [],
  });
  await expect(services.prepareDelivery(operation)).rejects.toThrow(
    "review required",
  );
  expect(createNotificationEventGraphInTransaction).not.toHaveBeenCalled();
  expect(db.query).not.toHaveBeenCalled();
});
