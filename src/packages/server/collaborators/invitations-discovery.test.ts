/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  resolveInvitationRecipientLocal,
  listInvitationProjectsLocal,
  inspectInvitationProject,
} from "./invitations-discovery";
import type { InspectInvitationProjectInput } from "@cocalc/util/people-invitation-discovery";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const RECIPIENT = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const mockHome = jest.fn();
const mockQuery = jest.fn();
const mockContacts = jest.fn();
const mockContact = jest.fn();
const mockSearch = jest.fn();
const mockUsername = jest.fn();
const mockRoute = jest.fn();
const mockInspect = jest.fn();
const mockResource = jest.fn();
const mockSettings = jest.fn();
const mockClient = jest.fn();
const mockFence = jest.fn();
const mockEncode = jest.fn();
const mockDecode = jest.fn();
const mockEmailHash = jest.fn();
jest.mock("@cocalc/server/projects/collaborators", () => ({
  ensureProjectCollabInviteEmailTokenSchema: jest.fn(),
  hashInviteEmail: (email) => mockEmailHash(email),
}));
jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => mockSettings(),
}));
jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  withProjectRehomeWriteFence: (opts) => mockFence(opts),
}));
jest.mock(
  "@cocalc/database/postgres/collaborators/collaborators-owner",
  () => ({ getOwnedCollaborationResource: (...args) => mockResource(...args) }),
);
jest.mock("@cocalc/conat/inter-bay/collaborators", () => ({
  createInterBayCollaboratorsClient: (opts) => mockClient(opts),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "home",
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => "fabric",
}));
jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (id) => mockRoute(id),
}));
jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  searchClusterAccounts: (opts) => mockSearch(opts),
}));
jest.mock("@cocalc/server/accounts/usernames", () => ({
  resolveUsernameOwner: (query) => mockUsername(query),
}));
jest.mock("@cocalc/server/people/api", () => ({
  listPeopleContacts: (opts) => mockContacts(opts),
  getPeopleContact: (opts) => mockContact(opts),
}));
jest.mock("@cocalc/server/people/common", () => ({
  peopleHome: (id) => mockHome(id),
  withPeopleAccount: (_id, fn) => fn({ query: mockQuery }),
  encodePeopleCursor: (...args) => mockEncode(...args),
  decodePeopleCursor: (...args) => mockDecode(...args),
}));

const recipient = { kind: "account" as const, account_id: RECIPIENT };
const target = {
  project_id: PROJECT,
  kind: "conversation" as const,
  resource_id: "thread",
};
const project = {
  project_id: PROJECT,
  title: "Current title",
  current_access: "collaborator",
  content_access: "allowed",
  can_invite: true,
  can_notify: true,
};
const contact = {
  account_id: ACTOR,
  person_id: CONTACT,
  linked_account_id: RECIPIENT,
  link_provenance: "explicit_account",
  display_label: "Private contact",
  email: null,
  archived: false,
};
function ownerInput(
  extra: Partial<InspectInvitationProjectInput> = {},
): InspectInvitationProjectInput {
  return {
    account_id: ACTOR,
    project_id: PROJECT,
    recipient,
    route: { bay_id: "home", epoch: 3 },
    ...extra,
  };
}
function ownerRow(
  actor = "owner",
  member: string | undefined = "collaborator",
  ownerOnly = false,
) {
  return {
    title: "Current title",
    users: { [ACTOR]: { group: actor }, [RECIPIENT]: { group: member } },
    manage_users_owner_only: ownerOnly,
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockSettings.mockResolvedValue({
    collaborators_enabled: true,
    user_search_max_results: 20,
  });
  mockHome.mockResolvedValue("home");
  mockContacts.mockResolvedValue({ items: [], total: 0, revision: "1" });
  mockContact.mockResolvedValue(contact);
  mockSearch.mockResolvedValue([]);
  mockUsername.mockRejectedValue(Error("Username owner not found"));
  mockRoute.mockResolvedValue({ bay_id: "remote", epoch: 3 });
  mockInspect.mockResolvedValue(project);
  mockClient.mockReturnValue({ inspectInvitationProject: mockInspect });
  mockResource.mockResolvedValue({ ...target, title: "Shared thread" });
  mockQuery.mockResolvedValue({ rows: [{ project_id: PROJECT }] });
  mockFence.mockImplementation(({ fn }) => fn({ query: mockQuery }));
  mockEncode.mockResolvedValue("signed-continuation");
  mockDecode.mockResolvedValue(undefined);
  mockEmailHash.mockResolvedValue("email-hash");
});

test("email input returns only an email specification and never performs any account lookup", async () => {
  const result = await resolveInvitationRecipientLocal({
    account_id: ACTOR,
    query: " Ada@Example.test ",
  });
  expect(result.recipients).toEqual([
    {
      kind: "email",
      email_address: "ada@example.test",
      label: "ada@example.test",
    },
  ]);
  expect(mockSearch).not.toHaveBeenCalled();
  expect(mockUsername).not.toHaveBeenCalled();
  expect(mockContacts).not.toHaveBeenCalled();
});
test.each(["Ada, ada@example.test", "ada@", "Ada <ada@example.test>"])(
  "mixed/incomplete email input %s cannot invoke account search",
  async (query) => {
    const result = await resolveInvitationRecipientLocal({
      account_id: ACTOR,
      query,
    });
    expect(result.recipients).toEqual([]);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUsername).not.toHaveBeenCalled();
  },
);
test("permitted name results omit email and administrative fields and deduplicate explicit contacts", async () => {
  mockContacts.mockResolvedValue({ items: [contact], total: 1 });
  mockSearch.mockResolvedValue([
    {
      account_id: RECIPIENT,
      display_name: "Public name",
      email_address: "private@example.test",
      home_bay_id: "secret-bay",
    },
    {
      account_id: OTHER,
      display_name: "Other person",
      email_address: "other@example.test",
    },
    { account_id: ACTOR, display_name: "Self" },
  ]);
  const result = await resolveInvitationRecipientLocal({
    account_id: ACTOR,
    query: "Ada",
  });
  expect(result.recipients).toEqual([
    {
      kind: "account",
      account_id: RECIPIENT,
      person_id: CONTACT,
      label: "Private contact",
    },
    { kind: "account", account_id: OTHER, label: "Other person" },
  ]);
  expect(mockSearch).toHaveBeenCalledWith({
    query: "ada",
    limit: 20,
    admin: false,
    only_email: false,
  });
  expect(mockContacts).toHaveBeenCalledWith({
    account_id: ACTOR,
    search: "Ada",
    limit: 20,
  });
});
test("exact @username goes through the existing username authority, not free-form account lookup", async () => {
  mockUsername.mockResolvedValue({
    account_id: RECIPIENT,
    username: "ada",
    redirect: false,
  });
  const result = await resolveInvitationRecipientLocal({
    account_id: ACTOR,
    query: "@ada",
  });
  expect(result.recipients).toEqual([
    { kind: "account", account_id: RECIPIENT, label: "ada", username: "ada" },
  ]);
  expect(mockUsername).toHaveBeenCalledWith("ada");
  expect(mockSearch).not.toHaveBeenCalled();
});
test("contact UUIDs cannot turn into account searches and email contacts remain email recipients", async () => {
  mockContacts.mockResolvedValue({
    items: [
      {
        ...contact,
        linked_account_id: null,
        link_provenance: null,
        email: "ada@example.test",
      },
    ],
  });
  const result = await resolveInvitationRecipientLocal({
    account_id: ACTOR,
    query: CONTACT,
  });
  expect(result.recipients[0]).toEqual({
    kind: "email",
    email_address: "ada@example.test",
    person_id: CONTACT,
    label: "Private contact",
  });
  expect(mockUsername).not.toHaveBeenCalled();
  expect(mockSearch).not.toHaveBeenCalled();
});
test("search honors the configured public-search bound", async () => {
  mockSettings.mockResolvedValue({
    collaborators_enabled: true,
    user_search_max_results: 3,
  });
  await resolveInvitationRecipientLocal({ account_id: ACTOR, query: "Ada" });
  expect(mockSearch.mock.calls[0][0].limit).toBe(3);
});
test("project candidates come from the home index but current permissions come from the owning bay", async () => {
  const result = await listInvitationProjectsLocal({
    account_id: ACTOR,
    recipient,
    query: "Algebra",
    project_ids: [PROJECT],
    target,
  });
  expect(mockQuery.mock.calls[0][0]).toContain("FROM account_project_index");
  expect(mockQuery.mock.calls[0][1]).toEqual([
    ACTOR,
    "Algebra",
    null,
    [PROJECT],
    26,
  ]);
  expect(mockClient).toHaveBeenCalledWith({
    client: "fabric",
    bay_id: "remote",
  });
  expect(mockInspect).toHaveBeenCalledWith({
    account_id: ACTOR,
    project_id: PROJECT,
    recipient,
    target,
    route: { bay_id: "remote", epoch: 3 },
  });
  expect(result.projects).toEqual([project]);
});
test("only 25 owner checks run and continuation advances over checked candidates including revoked ones", async () => {
  const ids = Array.from(
    { length: 26 },
    (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
  );
  mockQuery.mockResolvedValue({
    rows: ids.map((project_id) => ({ project_id })),
  });
  mockInspect.mockResolvedValue(null);
  const result = await listInvitationProjectsLocal({
    account_id: ACTOR,
    recipient,
  });
  expect(mockInspect).toHaveBeenCalledTimes(25);
  expect(result).toEqual({ projects: [], next_cursor: "signed-continuation" });
  expect(mockEncode).toHaveBeenCalledWith(
    expect.any(String),
    "1",
    [ids[24]],
    undefined,
  );
});
test("cursor resumes in SQL and is bound to actor, recipient, filters, and target", async () => {
  mockDecode.mockResolvedValue({ after: [PROJECT], expires: 123 });
  await listInvitationProjectsLocal({
    account_id: ACTOR,
    recipient,
    cursor: "cursor",
  });
  expect(mockQuery.mock.calls[0][1][2]).toBe(PROJECT);
  const firstBinding = mockDecode.mock.calls[0][1];
  for (const input of [
    { account_id: OTHER, recipient },
    { account_id: ACTOR, recipient: { ...recipient, account_id: OTHER } },
    { account_id: ACTOR, recipient, query: "different" },
    { account_id: ACTOR, recipient, project_ids: [PROJECT] },
    { account_id: ACTOR, recipient, target },
  ]) {
    await listInvitationProjectsLocal(input);
    expect(mockDecode.mock.lastCall[1]).not.toBe(firstBinding);
  }
});
test("unavailable owners fail closed without leaking stale projection metadata", async () => {
  mockInspect.mockRejectedValue(Error("secret internal host details"));
  const result = await listInvitationProjectsLocal({
    account_id: ACTOR,
    recipient,
  });
  expect(result.projects[0]).toMatchObject({
    current_access: "unknown",
    content_access: "unknown",
    can_invite: false,
    can_notify: false,
  });
  expect(JSON.stringify(result)).not.toContain("secret internal");
  expect(result.notice).toBeTruthy();
});
test("a contact ID is validated in its owner's namespace before project checks", async () => {
  await listInvitationProjectsLocal({
    account_id: ACTOR,
    recipient: { ...recipient, person_id: CONTACT },
  });
  expect(mockContact).toHaveBeenCalledWith({
    account_id: ACTOR,
    person_id: CONTACT,
  });
  expect(mockInspect.mock.calls[0][0].recipient.account_id).toBe(RECIPIENT);
  expect(mockInspect.mock.calls[0][0].account_id).toBe(ACTOR);
});
test.each([
  null,
  { ...contact, archived: true },
  { ...contact, linked_account_id: OTHER },
  { ...contact, link_provenance: null },
])(
  "unavailable/mismatched contacts stop before inspecting projects",
  async (value) => {
    mockContact.mockResolvedValue(value);
    await expect(
      listInvitationProjectsLocal({
        account_id: ACTOR,
        recipient: { ...recipient, person_id: CONTACT },
      }),
    ).rejects.toThrow("contact changed");
    expect(mockInspect).not.toHaveBeenCalled();
  },
);
test.each(["query", "projects", "cursor"])(
  "malformed %s is rejected before owner calls",
  async (kind) => {
    if (kind === "cursor")
      mockDecode.mockRejectedValue(Error("invalid people cursor"));
    const extra =
      kind === "query"
        ? { query: "x".repeat(201) }
        : kind === "projects"
          ? { project_ids: Array(26).fill(PROJECT) }
          : { cursor: "forged" };
    await expect(
      listInvitationProjectsLocal({ account_id: ACTOR, recipient, ...extra }),
    ).rejects.toThrow();
    expect(mockInspect).not.toHaveBeenCalled();
  },
);
test("local discovery rejects an obsolete account-home route", async () => {
  mockHome.mockResolvedValue("other-home");
  await expect(
    resolveInvitationRecipientLocal({ account_id: ACTOR, query: "Ada" }),
  ).rejects.toThrow("account-home");
  await expect(
    listInvitationProjectsLocal({ account_id: ACTOR, recipient }),
  ).rejects.toThrow("account-home");
  expect(mockQuery).not.toHaveBeenCalled();
});

describe("current owner inspection", () => {
  beforeEach(() => {
    mockRoute.mockResolvedValue({ bay_id: "home", epoch: 3 });
    mockQuery.mockImplementation(async (sql) => ({
      rows: sql.includes("project_collab_invites") ? [] : [ownerRow()],
    }));
  });
  test("uses owner permissions rather than assuming every collaborator can invite", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ownerRow("collaborator", "collaborator", true)],
    });
    expect(await inspectInvitationProject(ownerInput())).toMatchObject({
      current_access: "collaborator",
      content_access: "allowed",
      can_invite: false,
      can_notify: true,
    });
    expect(mockFence).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: PROJECT }),
    );
  });
  test.each(["owner", "collaborator", "viewer", undefined])(
    "returns recipient role %s independently of manage permission",
    async (role) => {
      mockQuery.mockResolvedValueOnce({
        rows: [ownerRow("owner", role ?? "none")],
      });
      const result = await inspectInvitationProject(ownerInput());
      expect(result?.current_access).toBe(role ?? "none");
      expect(result?.can_invite).toBe(true);
      expect(result?.can_notify).toBe(role !== undefined);
    },
  );
  test("email specifications never look up accounts or infer an existing membership", async () => {
    const result = await inspectInvitationProject(
      ownerInput({
        recipient: { kind: "email", email_address: "ada@example.test" },
      }),
    );
    expect(result).toMatchObject({
      current_access: "unknown",
      content_access: "unknown",
      can_notify: false,
      can_invite: true,
    });
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockUsername).not.toHaveBeenCalled();
  });
  test.each(["viewer", "none"])(
    "sender %s cannot disclose recipient membership",
    async (role) => {
      mockQuery.mockResolvedValueOnce({ rows: [ownerRow(role)] });
      expect(await inspectInvitationProject(ownerInput())).toBeNull();
    },
  );
  test("stale owner epoch is rejected before reading local project data", async () => {
    await expect(
      inspectInvitationProject(
        ownerInput({ route: { bay_id: "home", epoch: 2 } }),
      ),
    ).rejects.toThrow("project-owner");
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test("rehoming is rejected before using project membership", async () => {
    mockFence.mockRejectedValue(Error("project rehome in progress"));
    await expect(inspectInvitationProject(ownerInput())).rejects.toThrow(
      "rehome",
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test("target belongs to its existing project; discovery never promises automatic copying", async () => {
    const result = await inspectInvitationProject(
      ownerInput({ target: { ...target, project_id: OTHER } }),
    );
    expect(result).toMatchObject({
      can_invite: false,
      can_notify: false,
      content_access: "denied",
      unavailable_reason: expect.stringContaining("do not copy"),
    });
    expect(mockResource).not.toHaveBeenCalled();
  });
  test("missing target disables both actions after authoritative resource lookup", async () => {
    mockResource.mockResolvedValue(null);
    const result = await inspectInvitationProject(ownerInput({ target }));
    expect(mockResource).toHaveBeenCalledWith(target, ACTOR, {
      owning_bay_id: "home",
    });
    expect(result).toMatchObject({
      content_access: "denied",
      can_invite: false,
      can_notify: false,
    });
  });
  test("viewer content access is not equated to collaboration runtime access", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ownerRow("owner", "viewer")] });
    const result = await inspectInvitationProject(ownerInput({ target }));
    expect(result).toMatchObject({
      current_access: "viewer",
      content_access: "denied",
      can_invite: true,
      can_notify: false,
    });
  });
  test("pending offers expose only sender-owned role and policy, not tokens or other senders' invitations", async () => {
    const read_policy = { rules: [{ action: "include", path: "docs/**" }] };
    mockQuery
      .mockResolvedValueOnce({ rows: [ownerRow()] })
      .mockResolvedValueOnce({
        rows: [{ invite_role: "viewer", read_policy }],
      });
    const result = await inspectInvitationProject(ownerInput());
    expect(result?.pending).toEqual({ role: "viewer", read_policy });
    expect(mockQuery.mock.calls[1][0]).toContain("inviter_account_id=$2");
    expect(mockQuery.mock.calls[1][0]).toContain("LIMIT 2");
    expect(mockQuery.mock.calls[1][1]).toEqual([PROJECT, ACTOR, RECIPIENT]);
  });
  test("email pending offers use invitation email hashes without resolving the recipient to an account", async () => {
    await inspectInvitationProject(
      ownerInput({
        recipient: { kind: "email", email_address: "ada@example.test" },
      }),
    );
    expect(mockEmailHash).toHaveBeenCalledWith("ada@example.test");
    expect(mockQuery.mock.calls[1][1]).toEqual([PROJECT, ACTOR, "email-hash"]);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
