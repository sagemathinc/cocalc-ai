/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { PeopleInvitationPayload } from "@cocalc/util/people-invitations";
import type { PeopleExecuteInput } from "@cocalc/conat/inter-bay/people-actions";
import { DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY } from "@cocalc/util/project-access";

const mockQuery = jest.fn();
const mockRoute = jest.fn();
const mockHome = jest.fn();
const mockRemote = {
  preflight: jest.fn(),
  inspect: jest.fn(),
  execute: jest.fn(),
  checkSender: jest.fn(),
};
const mockResource = jest.fn();
const mockTrust = jest.fn();
const mockAccount = jest.fn();
const mockManage = jest.fn();
const mockCreate = jest.fn();
const mockEmail = jest.fn();
const mockLimit = jest.fn();
const mockFinish = jest.fn();
const receipts = new Map<string, { binding: string; receipt: any }>();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: mockQuery }),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: async () => ({ collaborators_enabled: true }),
}));
jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  withProjectRehomeWriteFence: ({ fn }) => fn({ query: mockQuery }),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({ getOwnedCollaborationResource: (...args) => mockResource(...args) }),
);
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "owner",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  resolveAccountHomeBay: (...args) => mockHome(...args),
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args) => mockRoute(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => mockAccount(...args),
}));
jest.mock("@cocalc/server/accounts/trusted-product-access", () => ({
  assertAccountTrustedForProductAccess: (...args) => mockTrust(...args),
}));
jest.mock("@cocalc/server/membership/project-limits", () => ({
  assertProjectCollaboratorInviteLimit: (...args) => mockLimit(...args),
}));
jest.mock("@cocalc/conat/inter-bay/people-actions", () => ({
  createInterBayPeopleActionsClient: () => mockRemote,
}));
jest.mock("@cocalc/server/projects/collaborators", () => ({
  assertCanManageProjectCollaborators: (...args) => mockManage(...args),
  assertEmailInviteBatchLimit: jest.fn(),
  assertEmailInviteCreationLimits: jest.fn(),
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(),
  hashInviteEmail: async (s) => `hash:${s}`,
  normalizeInviteMessageForAccount: jest.fn(),
  createCollabInvite: (...args) => mockCreate(...args),
  inviteCollaboratorWithoutAccount: (...args) => mockEmail(...args),
}));
jest.mock("./invitation-action-store", () => ({
  ensurePeopleActionSchema: jest.fn(),
  peopleActionBinding: async (i) =>
    JSON.stringify([i.account_id, i.child_operation_id, i.payload, i.action]),
  readPeopleAction: async (i, binding) => {
    const r = receipts.get(i.child_operation_id);
    if (r && r.binding !== binding)
      throw Error("invitation child operation payload mismatch");
    return r?.receipt;
  },
  claimPeopleAction: async (i, binding, check) => {
    await check();
    if (receipts.has(i.child_operation_id)) return false;
    receipts.set(i.child_operation_id, {
      binding,
      receipt: {
        child_operation_id: i.child_operation_id,
        project_id: i.action.project_id,
        action: i.action.action,
        status: "unknown",
        delivery: [],
      },
    });
    return true;
  },
  finishPeopleAction: (...args) => mockFinish(...args),
  recoverPeopleAction: async (i, binding, receipt) => {
    const row = receipts.get(i.child_operation_id)!;
    if (row.receipt.status !== "unknown") return row.receipt;
    receipts.set(i.child_operation_id, { binding, receipt });
    return receipt;
  },
}));

import {
  preflightPeopleInvitationAction,
  inspectPeopleInvitationAccess,
  executePeopleInvitationAccess,
  peopleActionsControl,
} from "./invitation-actions";

let input: PeopleExecuteInput;
let project: any;
let pendingRows: any[];
let createdRows: any[];
let blocked: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  receipts.clear();
  pendingRows = [];
  createdRows = [];
  blocked = false;
  const project_id = randomUUID();
  const payload: PeopleInvitationPayload = {
    recipient: { kind: "account", account_id: randomUUID() },
    projects: [{ project_id, action: "offer_access", role: "collaborator" }],
    message: "Please join",
    channels: { notification: true, email: true },
  };
  input = {
    account_id: randomUUID(),
    child_operation_id: randomUUID(),
    payload,
    action: payload.projects[0],
    authorization_expires_at: Date.now() + 60000,
  };
  project = {
    users: { [input.account_id]: { group: "owner" } },
    deleted: false,
    owning_bay_id: "owner",
  };
  mockRoute.mockResolvedValue({ bay_id: "owner", epoch: 0 });
  mockHome.mockResolvedValue({ home_bay_id: "owner" });
  mockAccount.mockResolvedValue({
    account_id: randomUUID(),
    home_bay_id: "recipient",
    banned: false,
  });
  mockResource.mockResolvedValue({ chat_path: "/notes.chat" });
  mockTrust.mockResolvedValue(undefined);
  mockManage.mockResolvedValue(undefined);
  mockLimit.mockResolvedValue(undefined);
  mockCreate.mockImplementation(async (_, options) => ({
    created: true,
    invite: { invite_id: options.invite_id },
  }));
  mockEmail.mockImplementation(async (_, options) => ({
    invites: [{ invite_id: options.invite_id }],
    email_sent: true,
  }));
  mockFinish.mockImplementation(async (i, binding, receipt) => {
    receipts.set(i.child_operation_id, { binding, receipt });
    return receipt;
  });
  mockQuery.mockImplementation(async (sql) => {
    if (sql.includes("FROM accounts"))
      return { rows: [{ banned: false, deleted: false }] };
    if (sql.includes("FROM projects")) return { rows: [project] };
    if (sql.includes("project_collab_invite_blocks"))
      return { rows: blocked ? [{}] : [] };
    if (sql.includes("status='pending'")) return { rows: pendingRows };
    if (sql.includes("WHERE invite_id=$1")) return { rows: createdRows };
    throw Error(`unexpected query: ${sql}`);
  });
});
function member(group = "collaborator") {
  if (input.payload.recipient.kind !== "account")
    throw Error("account required");
  project.users[input.payload.recipient.account_id] = { group };
}
function notify() {
  input.action = { project_id: input.action.project_id, action: "notify" };
  input.payload.projects = [input.action];
}
function email() {
  input.payload.recipient = {
    kind: "email",
    email_address: "recipient@example.invalid",
  };
}
function target() {
  input.payload.target = {
    project_id: input.action.project_id,
    kind: "artifact",
    resource_id: "stable-artifact",
  };
}
function offerRow(overrides = {}) {
  return {
    invite_id: randomUUID(),
    project_id: input.action.project_id,
    inviter_account_id: input.account_id,
    invitee_account_id:
      input.payload.recipient.kind === "account"
        ? input.payload.recipient.account_id
        : null,
    email_hash:
      input.payload.recipient.kind === "email"
        ? `hash:${input.payload.recipient.email_address}`
        : null,
    invite_role: "collaborator",
    read_policy: null,
    scope: null,
    context: null,
    status: "pending",
    message: "Please join",
    invite_source: "account",
    expires: new Date(Date.now() + 60000),
    ...overrides,
  };
}

it("routes all three calls to the live owner, not the sender home", async () => {
  mockRoute.mockResolvedValue({ bay_id: "remote-project", epoch: 17 });
  mockRemote.preflight.mockResolvedValue({ recipient_access: "insufficient" });
  mockRemote.inspect.mockResolvedValue(undefined);
  mockRemote.execute.mockResolvedValue({ status: "created" });
  await preflightPeopleInvitationAction(
    input.account_id,
    input.payload,
    input.action,
  );
  await inspectPeopleInvitationAccess(input);
  await executePeopleInvitationAccess(input);
  for (const fn of [
    mockRemote.preflight,
    mockRemote.inspect,
    mockRemote.execute,
  ])
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({
        route: { bay_id: "remote-project", epoch: 17 },
      }),
    );
  expect(mockQuery).not.toHaveBeenCalled();
});
it("checks human product trust at the sender home on another bay", async () => {
  mockHome.mockResolvedValue({ home_bay_id: "sender-home" });
  member();
  notify();
  await executePeopleInvitationAccess(input);
  expect(mockRemote.checkSender).toHaveBeenCalledWith({
    account_id: input.account_id,
    route: { bay_id: "sender-home" },
  });
  expect(mockTrust).not.toHaveBeenCalled();
});
it("rejects stale owner epochs", async () => {
  await expect(
    peopleActionsControl.preflight({
      ...input,
      route: { bay_id: "owner", epoch: 1 },
    }),
  ).rejects.toThrow("stale");
});
it("notify uses current access and never creates an offer", async () => {
  member();
  notify();
  target();
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "notified",
  });
  expect(mockResource).toHaveBeenCalledWith(
    input.payload.target,
    input.account_id,
    { owning_bay_id: "owner" },
  );
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockEmail).not.toHaveBeenCalled();
});
it("access loss after admission returns review_required, never a grant", async () => {
  member();
  notify();
  const query = mockQuery.getMockImplementation()!;
  let reads = 0;
  mockQuery.mockImplementation(async (sql, ...args) => {
    if (sql.includes("FROM projects") && ++reads === 2)
      project.users = { [input.account_id]: { group: "owner" } };
    return query(sql, ...args);
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it.each(["notify", "offer_access"] as const)(
  "owner-only membership management does not block permission-free %s",
  async (action) => {
    member();
    target();
    if (action === "notify") notify();
    project.users[input.account_id].group = "collaborator";
    project.manage_users_owner_only = true;
    mockManage.mockRejectedValue(
      Error(
        "only project owners can invite collaborators when owner-only collaborator management is enabled",
      ),
    );
    expect(
      await preflightPeopleInvitationAction(
        input.account_id,
        input.payload,
        input.action,
      ),
    ).toMatchObject({ recipient_access: "sufficient" });
    expect(await executePeopleInvitationAccess(input)).toMatchObject({
      status: "notified",
    });
    expect(mockManage).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockEmail).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "owner-only management still blocks an insufficient-access offer (pending=%s)",
  async (reuse) => {
    project.users[input.account_id].group = "collaborator";
    project.manage_users_owner_only = true;
    if (reuse) pendingRows = [offerRow()];
    mockManage.mockRejectedValue(
      Error(
        "only project owners can invite collaborators when owner-only collaborator management is enabled",
      ),
    );
    expect(await executePeopleInvitationAccess(input)).toMatchObject({
      status: "review_required",
      reason: "sender_cannot_manage_access",
    });
    expect(mockManage).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
  },
);
it("rechecks sender authority and recipient blocks", async () => {
  project.users = {};
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
  project.users = { [input.account_id]: { group: "owner" } };
  blocked = true;
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it("rejects deleted stable targets", async () => {
  target();
  mockResource.mockResolvedValue(null);
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
});
it("does not claim readable viewer files grant access to the People target opener", async () => {
  target();
  member("viewer");
  notify();
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
    reason: "content_requires_collaborator",
  });
});
it("compares current viewer read policy instead of silently enlarging it", async () => {
  member("viewer");
  input.action = {
    project_id: input.action.project_id,
    action: "offer_access",
    role: "viewer",
    read_policy: { rules: [{ action: "include", path: "different" }] },
  };
  input.payload.projects = [input.action];
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
  input.action.read_policy = DEFAULT_PROJECT_VIEWER_FULL_READ_POLICY;
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "notified",
  });
});
it("uses exact child identity and replays without repeating mutations", async () => {
  const first = await executePeopleInvitationAccess(input);
  expect(first).toMatchObject({
    status: "created",
    access_invite_id: input.child_operation_id,
  });
  input.authorization_expires_at = 0;
  expect(await executePeopleInvitationAccess(input)).toEqual(first);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockCreate.mock.calls[0][1]).toMatchObject({
    invite_id: input.child_operation_id,
    trustedProductAccessChecked: true,
  });
});
it("rejects payload substitution under an existing receipt", async () => {
  await executePeopleInvitationAccess(input);
  input.payload.message = "Different reviewed message";
  await expect(inspectPeopleInvitationAccess(input)).rejects.toThrow(
    "payload mismatch",
  );
});
it("rejects action substitution before routing", async () => {
  input.action = { project_id: input.action.project_id, action: "notify" };
  await expect(executePeopleInvitationAccess(input)).rejects.toThrow(
    "not in reviewed payload",
  );
  expect(mockRoute).not.toHaveBeenCalled();
});
it("expired authorization permits inspection but not first mutation", async () => {
  input.authorization_expires_at = 0;
  expect(await inspectPeopleInvitationAccess(input)).toBeUndefined();
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
    reason: "authorization_expired",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it("reuses only compatible authored offers without sending another email", async () => {
  email();
  const row = offerRow({
    scope: "project_collab",
    invite_source: "email",
    context: { require_invite_email_match: false },
  });
  pendingRows = [row];
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "reused",
    access_invite_id: row.invite_id,
    delivery: [{ channel: "email", status: "suppressed" }],
  });
  expect(mockEmail).not.toHaveBeenCalled();
});
it.each([
  { inviter_account_id: randomUUID() },
  { scope: "course_student" },
  { invite_role: "viewer" },
  { message: "Different" },
])("does not rewrite an incompatible/course offer %j", async (change) => {
  pendingRows = [offerRow(change)];
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
  expect(mockCreate).not.toHaveBeenCalled();
});
it("validates a pending offer racing the legacy helper before reuse", async () => {
  mockCreate.mockImplementation(async (_, options) => {
    const row = offerRow({ inviter_account_id: randomUUID() });
    createdRows = [row];
    await options.beforeReuse(row.invite_id);
    throw Error("must not mutate");
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "review_required",
  });
});
it("passes typed continuation to legacy email and obeys reviewed email channel", async () => {
  email();
  target();
  input.payload.channels.email = false;
  mockEmail.mockImplementation(async (_, o) => ({
    invites: [{ invite_id: o.invite_id }],
    email_sent: false,
    email_blocked_reason: "send_disabled_by_request",
  }));
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "created",
    delivery: [{ channel: "email", status: "suppressed" }],
  });
  expect(mockEmail.mock.calls[0][0].opts).toMatchObject({
    send_email: false,
    invite_context: {
      people_invitation: { version: 1, target: input.payload.target },
    },
  });
  expect(mockAccount).not.toHaveBeenCalled();
});
it("email specifications have unknown access without account resolution", async () => {
  email();
  expect(
    await preflightPeopleInvitationAction(
      input.account_id,
      input.payload,
      input.action,
    ),
  ).toMatchObject({ recipient_access: "unknown" });
  expect(mockAccount).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockEmail).not.toHaveBeenCalled();
});
it("includes authored email content as escaped text, never markup", async () => {
  email();
  target();
  input.payload.message = '<img src=x onerror="alert(1)">';
  input.payload.target!.label = "<b>label</b>";
  await executePeopleInvitationAccess(input);
  const body = mockEmail.mock.calls[0][0].opts.email;
  expect(body).toContain("&lt;img");
  expect(body).toContain("&lt;b&gt;label&lt;/b&gt;");
  expect(body).not.toContain("<img");
});
it("does not resend after an email timeout with no authoritative outcome", async () => {
  email();
  mockEmail.mockRejectedValue(Error("SMTP timeout after possible send"));
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "unknown",
  });
  expect(await inspectPeopleInvitationAccess(input)).toMatchObject({
    status: "unknown",
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "unknown",
  });
  expect(mockEmail).toHaveBeenCalledTimes(1);
});
it("recovers committed access by exact child ID while retaining unknown delivery", async () => {
  email();
  mockEmail.mockImplementation(async () => {
    createdRows = [{ invite_id: input.child_operation_id }];
    throw Error("crash after send");
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "created",
    access_invite_id: input.child_operation_id,
    delivery: [{ channel: "email", status: "unknown" }],
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "created",
  });
  expect(mockEmail).toHaveBeenCalledTimes(1);
});
it("a lost final receipt write never duplicates email", async () => {
  email();
  mockFinish.mockRejectedValue(Error("lost receipt write"));
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "unknown",
  });
  expect(await executePeopleInvitationAccess(input)).toMatchObject({
    status: "unknown",
  });
  expect(mockEmail).toHaveBeenCalledTimes(1);
});
it("concurrent submissions have only one legacy side effect", async () => {
  email();
  await Promise.all([
    executePeopleInvitationAccess(input),
    executePeopleInvitationAccess(input),
  ]);
  expect(mockEmail).toHaveBeenCalledTimes(1);
});
it("an inspect transport failure is not authoritative absence", async () => {
  mockRoute.mockResolvedValue({ bay_id: "offline-owner", epoch: 0 });
  mockRemote.inspect.mockRejectedValue(Error("timeout"));
  await expect(inspectPeopleInvitationAccess(input)).rejects.toThrow("timeout");
  expect(mockEmail).not.toHaveBeenCalled();
});
