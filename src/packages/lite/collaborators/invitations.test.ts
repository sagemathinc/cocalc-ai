/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { LiteCollaborators } from "./index";

const account_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const project_id = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
let store: LiteCollaborators;
let enabled: boolean;

beforeEach(() => {
  enabled = true;
  store = new LiteCollaborators({
    filename: ":memory:",
    account_id,
    project_id,
    isEnabled: () => enabled,
  });
});

afterEach(() => store.close());

function calls(account_id?: string) {
  const api = store.api;
  return {
    listPeopleContacts: () => api.listPeopleContacts({ account_id }),
    getPeopleContact: () => api.getPeopleContact({ account_id, person_id: id }),
    listInvitationHistory: () => api.listInvitationHistory({ account_id }),
    getInvitationCounts: () => api.getInvitationCounts({ account_id }),
    resolveInvitationRecipient: () =>
      api.resolveInvitationRecipient({
        account_id,
        query: "person@example.com",
      }),
    listInvitationProjects: () =>
      api.listInvitationProjects({
        account_id,
        recipient: { kind: "email", email_address: "person@example.com" },
      }),
    prepareInvitation: () =>
      api.prepareInvitation({
        account_id,
        draft_id: id,
        expected_revision: 0,
        payload: {
          recipient: { kind: "email", email_address: "person@example.com" },
          projects: [
            { project_id, action: "offer_access", role: "collaborator" },
          ],
          message: "Work together",
          channels: { notification: true, email: true },
        },
      }),
    reviewInvitation: () =>
      api.reviewInvitation({ account_id, draft_id: id, revision: 1 }),
    sendInvitation: () =>
      api.sendInvitation({
        account_id,
        draft_id: id,
        revision: 1,
        review_id: id,
        idempotency_key: id,
      }),
    getInvitationOperation: () =>
      api.getInvitationOperation({ account_id, operation_id: id }),
  };
}

test("single-user Lite has empty contacts and complete empty invitation history", async () => {
  const api = store.api;
  expect(await api.listPeopleContacts({ account_id })).toEqual({
    items: [],
    total: 0,
    revision: expect.any(String),
  });
  expect(await api.getPeopleContact({ account_id, person_id: id })).toBeNull();
  const counts = {
    pending: { sent: 0, received: 0 },
    unread: 0,
    revision: expect.any(String),
    coverage: "complete",
  };
  expect(await api.getInvitationCounts({ account_id })).toEqual(counts);
  for (const view of ["sent", "received", "history"] as const) {
    expect(await api.listInvitationHistory({ account_id, view })).toEqual({
      ...counts,
      items: [],
      total: 0,
    });
  }
});

test("invitation discovery and execution explicitly report unavailable in Lite", async () => {
  const methods = calls(account_id);
  for (const name of [
    "resolveInvitationRecipient",
    "listInvitationProjects",
    "prepareInvitation",
    "reviewInvitation",
    "sendInvitation",
    "getInvitationOperation",
  ] as const) {
    await expect(methods[name]()).rejects.toThrow(
      "Invitations are not available in standalone, single-user Lite",
    );
  }
});

test.each([undefined, "another-account"])(
  "all invitation methods require the local account: %s",
  async (caller) => {
    for (const call of Object.values(calls(caller))) {
      await expect(call()).rejects.toThrow("local Lite account");
    }
  },
);

test("all invitation methods respect the feature flag", async () => {
  enabled = false;
  for (const call of Object.values(calls(account_id))) {
    await expect(call()).rejects.toThrow("collaborators is disabled");
  }
});
