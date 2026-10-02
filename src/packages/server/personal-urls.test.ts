import { resolvePersonalUrl } from "./personal-urls";

const viewer = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const project_id = "33333333-3333-4333-8333-333333333333";
const agent_id = "44444444-4444-4444-8444-444444444444";
const resolveOwner = jest.fn();
const admin = jest.fn();
const lookup = jest.fn();
const member = jest.fn();
const identity = jest.fn();
const entry = jest.fn();
const resource = jest.fn();

jest.mock("./accounts/usernames", () => ({
  resolveUsernameOwner: (...args) => resolveOwner(...args),
  authorizeAdmin: (...args) => admin(...args),
}));
jest.mock("./personal-url-aliases", () => ({
  lookupPersonalUrlAlias: (...args) => lookup(...args),
}));
jest.mock("./conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: (...args) => member(...args),
}));
jest.mock("./agents/api", () => ({
  getIdentity: (...args) => identity(...args),
}));
jest.mock("./artifacts/catalog-api", () => ({
  getEntry: (...args) => entry(...args),
}));
jest.mock("./people/api", () => ({
  peopleApi: { getConversation: (...args) => resource(...args) },
}));

beforeEach(() => {
  jest.resetAllMocks();
  resolveOwner.mockResolvedValue({
    account_id: owner,
    username: "william",
    redirect: true,
  });
  member.mockResolvedValue({
    project_id,
    users: { [viewer]: { group: "collaborator" } },
  });
  lookup.mockResolvedValue({ kind: "agent", project_id, agent_id });
  identity.mockResolvedValue({
    path: "/home/user/work.chat",
    thread_id: "thread",
  });
});

test("the owner selects the namespace; the viewer authorizes the resource", async () => {
  const result = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/old-name/agents/agent-16",
  });
  expect(resolveOwner).toHaveBeenCalledWith("old-name");
  expect(lookup).toHaveBeenCalledWith({
    owner_account_id: owner,
    kind: "agents",
    alias: "agent-16",
  });
  expect(member).toHaveBeenCalledWith({ account_id: viewer, project_id });
  expect(identity).toHaveBeenCalledWith({
    account_id: viewer,
    project_id,
    agent_id,
  });
  expect(result).toMatchObject({
    status: "resolved",
    canonical_path: "/u/william/agents/agent-16",
    target: { agent_id, chat_path: "/home/user/work.chat" },
  });
});

test("UUID links remain independent of username changes", async () => {
  resolveOwner.mockResolvedValue({
    account_id: owner,
    username: null,
    redirect: false,
  });
  const result = await resolvePersonalUrl({
    account_id: viewer,
    url: `/u/${owner}/agents/agent-16`,
  });
  expect(result.canonical_path).toBe(`/u/${owner}/agents/agent-16`);
});

test("nonmembers only receive the project locator for requesting access", async () => {
  member.mockResolvedValue(null);
  expect(
    await resolvePersonalUrl({
      account_id: viewer,
      url: "/u/william/agents/agent-16",
    }),
  ).toEqual({
    owner: { account_id: owner, username: "william", redirect: true },
    kind: "agents",
    alias: "agent-16",
    canonical_path: "/u/william/agents/agent-16",
    status: "access-denied",
    project_id,
  });
  expect(identity).not.toHaveBeenCalled();
});

test("network errors and revoked access are not misreported as missing aliases", async () => {
  member.mockRejectedValueOnce(Error("owning bay unavailable"));
  await expect(
    resolvePersonalUrl({
      account_id: viewer,
      url: "/u/william/agents/agent-16",
    }),
  ).rejects.toThrow("owning bay unavailable");
  identity.mockRejectedValueOnce(Error("membership revoked"));
  await expect(
    resolvePersonalUrl({
      account_id: viewer,
      url: "/u/william/agents/agent-16",
    }),
  ).rejects.toThrow("membership revoked");
});

test("artifacts and conversations are looked up as the viewer, never owner", async () => {
  lookup.mockResolvedValueOnce({
    kind: "artifact",
    project_id,
    entry_id: "a".repeat(64),
  });
  entry.mockResolvedValue({
    chat_path: "/artifacts.chat",
    item: { thread_id: "thread", artifact_id: "report" },
  });
  const artifact = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/william/artifacts/primes",
  });
  expect(entry).toHaveBeenCalledWith({
    account_id: viewer,
    project_id,
    entry_id: "a".repeat(64),
  });
  expect(artifact.target).toMatchObject({
    kind: "artifact",
    artifact_id: "report",
  });
  lookup.mockResolvedValueOnce({
    kind: "conversation",
    project_id,
    conversation_id: "chat",
  });
  resource.mockResolvedValue({ path: "/human.chat" });
  const conversation = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/william/chats/chat1",
  });
  expect(resource).toHaveBeenCalledWith({
    account_id: viewer,
    project_id,
    conversation_id: "chat",
  });
  expect(conversation.target).toMatchObject({
    kind: "conversation",
    chat_path: "/human.chat",
  });
});

test("missing aliases never fall back to the viewer's namespace", async () => {
  lookup.mockResolvedValue(null);
  const result = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/william/artifacts/primes",
  });
  expect(result.status).toBe("unavailable");
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(member).not.toHaveBeenCalled();
});

test("old private person nicknames are not made public by qualified routes", async () => {
  expect(
    (
      await resolvePersonalUrl({
        account_id: viewer,
        url: "/u/william/people/bella",
      })
    ).status,
  ).toBe("unavailable");
  expect(lookup).not.toHaveBeenCalled();
  lookup.mockResolvedValue({ kind: "person", person_id: viewer });
  expect(
    (
      await resolvePersonalUrl({
        account_id: owner,
        url: "/u/william/people/bella",
      })
    ).target,
  ).toEqual({ kind: "person", person_id: viewer });
});

test("inspection requires admin at the caller home and returns only alias locator", async () => {
  admin.mockRejectedValueOnce(Error("Must be an admin"));
  await expect(
    resolvePersonalUrl({
      account_id: viewer,
      url: "/u/william/agents/agent-16",
      inspect: true,
    }),
  ).rejects.toThrow("Must be an admin");
  expect(lookup).not.toHaveBeenCalled();
  const result = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/william/agents/agent-16",
    inspect: true,
  });
  expect(admin).toHaveBeenCalledWith(viewer);
  expect(result).toMatchObject({
    status: "inspection",
    target: { kind: "agent", project_id, agent_id },
  });
  expect(member).not.toHaveBeenCalled();
  expect(identity).not.toHaveBeenCalled();
});

test.each([
  "/agents/agent-16",
  "/u/william/agents",
  "/u/william/agents/%2fsecret",
])("invalid or unqualified URL %s is rejected", async (url) => {
  await expect(
    resolvePersonalUrl({ account_id: viewer, url }),
  ).rejects.toThrow();
  expect(lookup).not.toHaveBeenCalled();
});

test("project links carry the path inside the project", async () => {
  lookup.mockResolvedValue({ kind: "project", project_id });
  const result = await resolvePersonalUrl({
    account_id: viewer,
    url: "/u/william/projects/research/files/paper.tex",
  });
  expect(lookup).toHaveBeenCalledWith({
    owner_account_id: owner,
    kind: "projects",
    alias: "research",
  });
  expect(result).toMatchObject({
    status: "resolved",
    canonical_path: "/u/william/projects/research",
    rest: "files/paper.tex",
    target: { kind: "project", project_id },
  });
  // Aliases are public names: a nonmember learns only the project id.
  member.mockResolvedValue(null);
  expect(
    await resolvePersonalUrl({
      account_id: viewer,
      url: "/u/william/projects/research",
    }),
  ).toMatchObject({ status: "access-denied", project_id });
});
