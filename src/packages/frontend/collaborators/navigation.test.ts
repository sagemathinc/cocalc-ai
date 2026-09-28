const setState = jest.fn();
const setActiveTab = jest.fn();
let accountId = "me";
const resolvePersonAlias = jest.fn();
const resolveChatAlias = jest.fn();
const accountListeners = new Set<() => void>();
let pageState: Record<string, unknown> = {};
const replaceUrl = jest.fn();
jest.mock("@cocalc/frontend/history", () => ({
  replace_url: (...args) => replaceUrl(...args),
}));
jest.mock("./workspace-api", () => ({
  boundCollaboratorsApi: () => ({ resolvePersonAlias, resolveChatAlias }),
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: () => ({ setState, set_active_tab: setActiveTab }),
    getStore: (name) => ({
      get: (key) => (name === "page" ? pageState[key] : accountId),
      on: (_event, fn) => accountListeners.add(fn),
      removeListener: (_event, fn) => accountListeners.delete(fn),
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
  accountId = "me";
  pageState = {};
  cancelAliasNavigation();
});

test("canonicalizing a saved alias changes metadata/URL only, preserving stable selection", async () => {
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
  expect(await canonicalizeCollaboratorsAlias("me", route, "Weekly")).toBe(
    true,
  );
  expect(setState).toHaveBeenLastCalledWith({
    collaborators_alias: "weekly",
    collaborators_alias_kind: "chats",
  });
  expect(replaceUrl).toHaveBeenLastCalledWith("/chats/weekly");
  expect(setActiveTab).not.toHaveBeenCalled();
  expect(resolveChatAlias).not.toHaveBeenCalled();
  await canonicalizeCollaboratorsAlias("me", route, null);
  expect(replaceUrl).toHaveBeenLastCalledWith(
    "/collaborators/conversations/project/project/resource/conversation/thread",
  );
  expect(withCollaboratorsAlias(route, "old free-form label")).toMatchObject({
    resourceId: "thread",
    alias: undefined,
  });
  accountId = "other";
  expect(await canonicalizeCollaboratorsAlias("me", route, "private")).toBe(
    false,
  );
  accountId = "me";
  pageState.collaborators_resource_id = "new-selection";
  expect(
    await canonicalizeCollaboratorsAlias("me", route, "old-selection"),
  ).toBe(false);
});

test("only the latest pending alias label can canonicalize the same selection", async () => {
  const route = { view: "people" as const, personId: "person" };
  pageState = {
    active_top_tab: "agents",
    collaborators_open: true,
    collaborators_view: "people",
    collaborators_person_id: "person",
  };
  const older = canonicalizeCollaboratorsAlias("me", route, "older");
  const newer = canonicalizeCollaboratorsAlias("me", route, "newer");
  expect(await older).toBe(false);
  expect(await newer).toBe(true);
  expect(replaceUrl.mock.calls).toEqual([["/people/newer"]]);
  const interrupted = canonicalizeCollaboratorsAlias("me", route, "stale");
  cancelAliasNavigation();
  expect(await interrupted).toBe(false);
  expect(replaceUrl).toHaveBeenCalledTimes(1);
});

test("alias resolution selects stable identities without agent invocation or history mutation", async () => {
  resolvePersonAlias.mockResolvedValue({ account_id: "person-id" });
  await resolveCollaboratorsAlias(
    { view: "people", aliasKind: "people", alias: "alice" },
    cancelAliasNavigation(),
  );
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      collaborators_person_id: "person-id",
      collaborators_alias: "alice",
    }),
  );
  resolveChatAlias.mockResolvedValue({
    project_id: "project-id",
    kind: "conversation",
    resource_id: "thread-id",
  });
  await resolveCollaboratorsAlias(
    { aliasKind: "chats", alias: "weekly" },
    cancelAliasNavigation(),
  );
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      collaborators_project_id: "project-id",
      collaborators_resource_id: "thread-id",
    }),
  );
  expect(setActiveTab).not.toHaveBeenCalled();
});
test.each(["account", "navigation"])(
  "late alias response cannot overwrite %s switch",
  async (mode) => {
    let finish!: (result: unknown) => void;
    resolvePersonAlias.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const request = resolveCollaboratorsAlias(
      { aliasKind: "people", alias: "alice" },
      cancelAliasNavigation(),
    );
    await Promise.resolve();
    await Promise.resolve();
    if (mode === "account") accountId = "other";
    else cancelAliasNavigation();
    finish({ account_id: "private-old-account-person" });
    await request;
    expect(setState).not.toHaveBeenCalled();
  },
);
test("unavailable aliases clear stale targets and fail closed", async () => {
  resolvePersonAlias.mockResolvedValue(null);
  await resolveCollaboratorsAlias(
    { view: "people", aliasKind: "people", alias: "alice" },
    cancelAliasNavigation(),
  );
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      collaborators_person_id: undefined,
      collaborators_route_error: expect.stringContaining("unavailable"),
    }),
  );
});

test("an already resolved private alias is cleared and re-resolved on account switch", async () => {
  resolvePersonAlias
    .mockResolvedValueOnce({ account_id: "alice-person" })
    .mockResolvedValueOnce(null);
  await resolveCollaboratorsAlias(
    { aliasKind: "people", alias: "friend" },
    cancelAliasNavigation(),
  );
  accountId = "bob";
  for (const fn of [...accountListeners]) fn();
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      collaborators_person_id: undefined,
      collaborators_route_error: "Resolving private alias...",
    }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(setState).toHaveBeenLastCalledWith(
    expect.objectContaining({
      collaborators_person_id: undefined,
      collaborators_route_error: expect.stringContaining("unavailable"),
    }),
  );
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
