const setState = jest.fn();
const setActiveTab = jest.fn();
let accountId = "alice";
let pageState: Record<string, unknown> = {};
const replaceUrl = jest.fn();
const resolvePersonalUrl = jest.fn();
jest.mock("@cocalc/frontend/personal-url-navigation", () => ({
  resolvePersonalUrl: (...args) => resolvePersonalUrl(...args),
}));
jest.mock("@cocalc/frontend/history", () => ({
  replace_url: (...args) => replaceUrl(...args),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState, set_active_tab: setActiveTab }),
    getStore: (name) => ({
      get: (key) => (name === "page" ? pageState[key] : accountId),
    }),
  },
}));
import {
  openCollaborators,
  cancelAliasNavigation,
  resolveCollaboratorsAlias,
  canonicalizeCollaboratorsAlias,
  withCollaboratorsAlias,
} from "./navigation";

beforeEach(() => {
  jest.clearAllMocks();
  accountId = "alice";
  pageState = {};
  cancelAliasNavigation();
});

test("canonicalizing a saved alias preserves stable selection and qualifies its owner", async () => {
  const route = {
    view: "conversations" as const,
    projectId: "project",
    resourceKind: "conversation" as const,
    resourceId: "thread",
  };
  pageState = {
    active_top_tab: "agents",
    collaborators_open: true,
    collaborators_view: "conversations",
    collaborators_project_id: "project",
    collaborators_resource_kind: "conversation",
    collaborators_resource_id: "thread",
  };
  expect(await canonicalizeCollaboratorsAlias("alice", route, "Weekly")).toBe(
    true,
  );
  expect(setState).toHaveBeenLastCalledWith({
    collaborators_alias: "weekly",
    collaborators_alias_kind: "chats",
    collaborators_alias_owner: "alice",
  });
  expect(replaceUrl).toHaveBeenLastCalledWith("/u/alice/chats/weekly");
  expect(resolvePersonalUrl).toHaveBeenLastCalledWith(
    "u/alice/chats/weekly",
    true,
  );
  expect(setActiveTab).not.toHaveBeenCalled();
  await canonicalizeCollaboratorsAlias("alice", route, null);
  expect(replaceUrl).toHaveBeenLastCalledWith(
    "/people/conversations/project/project/resource/conversation/thread",
  );
  expect(withCollaboratorsAlias(route, "old free-form label")).toMatchObject({
    resourceId: "thread",
    alias: undefined,
  });
  accountId = "bob";
  expect(await canonicalizeCollaboratorsAlias("alice", route, "private")).toBe(
    false,
  );
  accountId = "alice";
  pageState.collaborators_resource_id = "new-selection";
  expect(
    await canonicalizeCollaboratorsAlias("alice", route, "old-selection"),
  ).toBe(false);
});

test("viewer metadata cannot overwrite a foreign owner's qualified URL", async () => {
  pageState = {
    active_top_tab: "agents",
    collaborators_open: true,
    collaborators_view: "people",
    collaborators_person_id: "person",
    personal_url: "u/bob/people/friend",
    personal_url_owner_account_id: "bob",
  };
  expect(
    await canonicalizeCollaboratorsAlias(
      "alice",
      { view: "people", personId: "person" },
      "my-friend",
    ),
  ).toBe(false);
  expect(replaceUrl).not.toHaveBeenCalled();
});

test("only the latest pending alias label can canonicalize the same selection", async () => {
  const route = { view: "people" as const, personId: "person" };
  pageState = {
    active_top_tab: "agents",
    collaborators_open: true,
    collaborators_view: "people",
    collaborators_person_id: "person",
  };
  const older = canonicalizeCollaboratorsAlias("alice", route, "older");
  const newer = canonicalizeCollaboratorsAlias("alice", route, "newer");
  expect(await older).toBe(false);
  expect(await newer).toBe(true);
  expect(replaceUrl.mock.calls).toEqual([["/u/alice/people/newer"]]);
  const interrupted = canonicalizeCollaboratorsAlias("alice", route, "stale");
  cancelAliasNavigation();
  expect(await interrupted).toBe(false);
});

test("alias lookup delegates the explicit owner to the shared resolver", async () => {
  await resolveCollaboratorsAlias(
    { aliasOwner: "bob", aliasKind: "chats", alias: "weekly" },
    cancelAliasNavigation(),
  );
  expect(resolvePersonalUrl).toHaveBeenCalledWith("u/bob/chats/weekly");
  resolvePersonalUrl.mockClear();
  await resolveCollaboratorsAlias(
    { aliasKind: "chats", alias: "weekly" },
    cancelAliasNavigation(),
  );
  expect(resolvePersonalUrl).not.toHaveBeenCalled();
});

test("opening Collaborators hides Library without selecting or invoking an agent", () => {
  openCollaborators({
    view: "people",
    personId: "person-1",
    projectId: "project-1",
  });
  expect(setState).toHaveBeenCalledWith(
    expect.objectContaining({
      library_open: false,
      collaborators_open: true,
      collaborators_view: "people",
      collaborators_person_id: "person-1",
      collaborators_project_id: "project-1",
    }),
  );
  expect(setState.mock.calls[0][0]).not.toHaveProperty("active_agent_id");
  expect(setActiveTab).toHaveBeenCalledWith("agents");
});
