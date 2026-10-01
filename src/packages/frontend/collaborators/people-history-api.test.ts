/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PeopleAccessInvitation } from "@cocalc/util/people-invitation-history";
import { boundPeopleHistoryApi } from "./people-history-api";
import { parseCollaboratorsRoute } from "./routing";

jest.mock("@cocalc/frontend/customize/app-base-path", () => ({
  appBasePath: "/deployment",
}));

let mockAccount = "owner-account";
const mockListContacts = jest.fn();
const mockGetContact = jest.fn();
const mockHistory = jest.fn();
const mockCopy = jest.fn();
const mockRespond = jest.fn();
const mockResend = jest.fn();
const mockNotify = jest.fn();
const mockWriteText = jest.fn();
const makeClient = () => ({
  hub: {
    collaborators: {
      listPeopleContacts: mockListContacts,
      getPeopleContact: mockGetContact,
      listInvitationHistory: mockHistory,
    },
    projects: {
      copyEmailProjectInviteLink: mockCopy,
      respondCollabInvite: mockRespond,
      resendCollabInvite: mockResend,
    },
  },
});

test("resend retains an unknown operation key and never creates a new send on a transport retry", async () => {
  const api = boundPeopleHistoryApi("owner-account");
  mockResend.mockRejectedValueOnce(Error("Timed out"));
  await expect(api.manage(row, "resend")).rejects.toThrow("Timed out");
  const operation = mockResend.mock.calls[0][0];
  mockResend.mockResolvedValueOnce({ status: "unknown" });
  expect(await api.manage(row, "resend")).toMatch(/outcome is unknown/);
  expect(mockResend).toHaveBeenLastCalledWith(operation);
  mockResend.mockResolvedValueOnce({ status: "sent" });
  expect(await api.manage(row, "resend")).toMatch(/submitted/);
  expect(mockResend).toHaveBeenLastCalledWith(operation);
  mockResend.mockResolvedValueOnce({ status: "not_sent", reason: "cooldown" });
  expect(await api.manage(row, "resend")).toMatch(
    /No email was sent: cooldown/,
  );
  expect(mockResend.mock.lastCall[0].operation_id).not.toEqual(
    operation.operation_id,
  );
  expect(mockResend.mock.lastCall[0]).toMatchObject({
    project_id: row.project_id,
    invite_id: row.invitation_id,
  });
});
let mockClient = makeClient();
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: { getStore: () => ({ get: () => mockAccount }) },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    get conat_client() {
      return mockClient;
    },
  },
}));
jest.mock("./invite-events", () => ({
  notifyCollabInvitesChanged: (...args) => mockNotify(...args),
}));

const CONTACT = "33333333-3333-4333-8333-333333333333";
const row: PeopleAccessInvitation = {
  kind: "access",
  invitation_id: "invitation-id",
  project_id: "project-id",
  sender_account_id: "sender-account",
  recipient_account_id: "recipient-account",
  person_id: CONTACT,
  message: null,
  created_at: "2026-09-29T00:00:00Z",
  updated_at: "2026-09-29T00:00:00Z",
  source_version: "1",
  source_bay_id: "bay-1",
  accepted_account_id: null,
  status: "pending",
  role: "collaborator",
  read_policy: null,
  invite_source: "email",
  scope: null,
  expires_at: null,
  responded_at: null,
  last_sent_at: null,
  resend_count: 0,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockAccount = "owner-account";
  mockClient = makeClient();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mockWriteText },
  });
  mockCopy.mockResolvedValue({
    invite_url: "https://example.test/invite/token",
  });
});

const reads = [
  {
    name: "listPeopleContacts" as const,
    rpc: mockListContacts,
    input: { cursor: "next", limit: 25, without_shared_projects: true },
  },
  {
    name: "getPeopleContact" as const,
    rpc: mockGetContact,
    input: { person_id: CONTACT },
  },
  {
    name: "listInvitationHistory" as const,
    rpc: mockHistory,
    input: {
      person_id: CONTACT,
      view: "sent" as const,
      project_ids: ["project-id"],
    },
  },
];

test.each(reads)(
  "$name binds the actor account without substituting contact identity",
  async ({ name, rpc, input }) => {
    const result = { items: [], revision: "1" };
    rpc.mockResolvedValue(result);
    const api = boundPeopleHistoryApi("owner-account");
    // Simulate an untrusted extra actor field on a runtime object.
    const request = { ...input, account_id: CONTACT };
    expect(
      await (api[name] as (input: unknown) => Promise<unknown>)(request),
    ).toBe(result);
    expect(rpc).toHaveBeenCalledWith({ ...input, account_id: "owner-account" });
    expect(request.account_id).toBe(CONTACT);
    expect(mockRespond).not.toHaveBeenCalled();
  },
);

describe.each(["account", "client"] as const)("%s changes", (change) => {
  function changeSession() {
    if (change === "account") mockAccount = "other-account";
    else mockClient = makeClient();
  }
  test.each(reads)(
    "$name rejects both late replies and subsequent calls",
    async ({ name, rpc, input }) => {
      const pending = deferred<unknown>();
      rpc.mockReturnValue(pending.promise);
      const api = boundPeopleHistoryApi("owner-account");
      const read = api[name] as (input: unknown) => Promise<unknown>;
      const response = read(input);
      changeSession();
      pending.resolve({ items: [{ person_id: CONTACT }] });
      await expect(response).rejects.toThrow("session changed");
      await expect(read(input)).rejects.toThrow("session changed");
      expect(rpc).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["copy", "accept", "decline", "revoke"] as const)(
    "late %s produces no clipboard write or refresh notification",
    async (action) => {
      const pending = deferred<unknown>();
      (action === "copy" ? mockCopy : mockRespond).mockReturnValue(
        pending.promise,
      );
      const response = boundPeopleHistoryApi("owner-account").manage(
        row,
        action,
      );
      changeSession();
      pending.resolve({ invite_url: "https://example.test/invite/token" });
      await expect(response).rejects.toThrow("session changed");
      expect(mockWriteText).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );
});

test.each(["accept", "decline", "revoke"] as const)(
  "%s routes by project and invitation IDs, never by contact/account recipient",
  async (action) => {
    await boundPeopleHistoryApi("owner-account").manage(row, action);
    expect(mockRespond).toHaveBeenCalledWith({
      account_id: "owner-account",
      project_id: row.project_id,
      invite_id: row.invitation_id,
      action,
    });
    expect(mockNotify).toHaveBeenCalledWith(row.project_id);
    expect(mockCopy).not.toHaveBeenCalled();
  },
);

test("copy uses the routed project API and copies only its returned URL", async () => {
  await boundPeopleHistoryApi("owner-account").manage(row, "copy");
  expect(mockCopy).toHaveBeenCalledWith({
    account_id: "owner-account",
    project_id: row.project_id,
    invite_id: row.invitation_id,
    invite_base_url: window.location.origin,
  });
  expect(mockWriteText).toHaveBeenCalledWith(
    "https://example.test/invite/token",
  );
  expect(mockNotify).not.toHaveBeenCalled();
});

test("account invite links open the exact recipient inbox without issuing an email token or changing access", async () => {
  const invitation_id = "44444444-4444-4444-8444-444444444444";
  const message = await boundPeopleHistoryApi("owner-account").manage(
    { ...row, invitation_id, invite_source: "account" },
    "copy",
  );
  const link = new URL(mockWriteText.mock.calls[0][0]);
  expect(link.origin).toBe(window.location.origin);
  expect(link.pathname).toBe("/deployment/people/invites");
  expect(parseCollaboratorsRoute(["invites"], link.search)).toEqual({
    view: "invites",
    invitationId: invitation_id,
  });
  expect(message).toContain("sign in to the invited account");
  expect(mockCopy).not.toHaveBeenCalled();
  expect(mockRespond).not.toHaveBeenCalled();
  expect(mockResend).not.toHaveBeenCalled();
});

test("account links are unavailable without a pending, identified recipient", async () => {
  const api = boundPeopleHistoryApi("owner-account");
  await expect(
    api.manage(
      { ...row, invite_source: "account", recipient_account_id: null },
      "copy",
    ),
  ).rejects.toThrow("not available");
  await expect(
    api.manage({ ...row, invite_source: "account", status: "expired" }, "copy"),
  ).rejects.toThrow("not available");
  expect(mockWriteText).not.toHaveBeenCalled();
});

test("RPC and clipboard failures propagate without success notifications", async () => {
  const api = boundPeopleHistoryApi("owner-account");
  mockRespond.mockRejectedValueOnce(Error("RPC unavailable"));
  await expect(api.manage(row, "accept")).rejects.toThrow("RPC unavailable");
  mockWriteText.mockRejectedValueOnce(Error("clipboard denied"));
  await expect(api.manage(row, "copy")).rejects.toThrow("clipboard denied");
  expect(mockNotify).not.toHaveBeenCalled();
});

test("an unbound account never performs reads or invitation actions", async () => {
  const api = boundPeopleHistoryApi("");
  await expect(api.getPeopleContact({ person_id: CONTACT })).rejects.toThrow(
    "session changed",
  );
  await expect(api.manage(row, "accept")).rejects.toThrow("session changed");
  expect(mockGetContact).not.toHaveBeenCalled();
  expect(mockRespond).not.toHaveBeenCalled();
});

test.each(["dismiss"] as const)(
  "unsupported %s is not silently translated into an access mutation",
  async (action) => {
    await expect(
      boundPeopleHistoryApi("owner-account").manage(row, action),
    ).rejects.toThrow("not available");
    expect(mockRespond).not.toHaveBeenCalled();
    expect(mockCopy).not.toHaveBeenCalled();
  },
);
