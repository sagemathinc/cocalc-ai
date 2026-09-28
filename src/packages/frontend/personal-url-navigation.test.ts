import type { ResolvedPersonalUrl } from "@cocalc/util/personal-urls";
import { dispatchUsernameChanged } from "./account/username-events";

let viewer: string | undefined = "alice";
let signedIn = true;
let page: Record<string, unknown> = {};
const accountListeners = new Set<() => void>();
const resolveUrl = jest.fn();
const replaceUrl = jest.fn();
const client = { hub: { personalUrls: { resolveUrl } } };
const webappClient = { conat_client: client, is_signed_in: () => signedIn };
const setState = jest.fn((update) => Object.assign(page, update));
jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getStore: (name) =>
      name === "page"
        ? { get: (key) => page[key] }
        : {
            get: (key) => (key === "account_id" ? viewer : signedIn),
            on: (_event, fn) => accountListeners.add(fn),
            removeListener: (_event, fn) => accountListeners.delete(fn),
          },
    getActions: () => ({ setState }),
  },
}));
jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));
jest.mock("./history", () => ({
  replace_url: (...args) => replaceUrl(...args),
}));
import {
  personalUrlSelection,
  resolvePersonalUrl,
} from "./personal-url-navigation";
import {
  cancelPersonalUrlNavigation,
  refreshPersonalUrlOwner,
} from "./personal-url-state";

const artifact: ResolvedPersonalUrl = {
  owner: { account_id: "bob", username: "bob", redirect: false },
  kind: "artifacts",
  alias: "notes",
  canonical_path: "/u/bob/artifacts/notes",
  status: "resolved",
  target: {
    kind: "artifact",
    project_id: "canonical-project",
    entry_id: "canonical-entry",
  },
};

beforeEach(() => {
  cancelPersonalUrlNavigation();
  jest.clearAllMocks();
  viewer = "alice";
  signedIn = true;
  page = {};
  webappClient.conat_client = client;
  resolveUrl.mockReset().mockResolvedValue(artifact);
});
afterEach(cancelPersonalUrlNavigation);

test("foreign alias resolution uses the qualified URL, not the viewer's library", async () => {
  await resolvePersonalUrl("u/bob/artifacts/notes");
  expect(resolveUrl).toHaveBeenCalledWith({ url: "/u/bob/artifacts/notes" });
  expect(page).toMatchObject({
    personal_url: "u/bob/artifacts/notes",
    personal_url_status: "resolved",
    personal_url_viewer: "alice",
    library_project_id: "canonical-project",
    library_entry_id: "canonical-entry",
  });
  expect(replaceUrl).toHaveBeenCalledWith("/u/bob/artifacts/notes");
});

test.each(["unavailable", "access-denied", "inspection"] as const)(
  "%s cannot open a content locator, even if one is returned",
  async (status) => {
    resolveUrl.mockResolvedValue({ ...artifact, status });
    await resolvePersonalUrl("u/bob/artifacts/notes");
    expect(page).toMatchObject({
      personal_url: "u/bob/artifacts/notes",
      personal_url_status: "error",
      library_project_id: undefined,
      active_agent_id: undefined,
      collaborators_resource_id: undefined,
    });
    expect(replaceUrl).not.toHaveBeenCalled();
  },
);

test.each([
  "u//artifacts/notes",
  "u/bob/artifacts/a/b",
  "u/bob/chats/%",
  "u/bob/chats/%2F",
])(
  "malformed qualified route %s never reaches a name resolver",
  async (url) => {
    await resolvePersonalUrl(url);
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(page.personal_url_status).toBe("error");
  },
);

test("owner redirects only replace history with the server's canonical qualified path", async () => {
  await resolvePersonalUrl("u/old-bob/artifacts/notes");
  expect(replaceUrl.mock.calls).toEqual([["/u/bob/artifacts/notes"]]);
  expect(page.personal_url).toBe("u/bob/artifacts/notes");
});

test.each([
  ["explicit refresh", () => refreshPersonalUrlOwner("bob")],
  [
    "settings username event",
    () =>
      dispatchUsernameChanged({ account_id: "bob", username: "bob-renamed" }),
  ],
] as const)(
  "%s resolves exactly once and canonicalizes the mounted link without a history push",
  async (_label, refresh) => {
    await resolvePersonalUrl("u/bob/artifacts/notes");
    resolveUrl.mockClear().mockResolvedValue({
      ...artifact,
      owner: { ...artifact.owner, username: "bob-renamed" },
      canonical_path: "/u/bob-renamed/artifacts/notes",
    });
    replaceUrl.mockClear();
    refresh();
    await new Promise((done) => setTimeout(done, 0));
    expect(resolveUrl.mock.calls).toEqual([
      [{ url: "/u/bob/artifacts/notes" }],
    ]);
    expect(page.personal_url).toBe("u/bob-renamed/artifacts/notes");
    expect(replaceUrl.mock.calls).toEqual([["/u/bob-renamed/artifacts/notes"]]);
  },
);

test("username events for another owner or after leaving the route do not resolve it", async () => {
  await resolvePersonalUrl("u/bob/artifacts/notes");
  resolveUrl.mockClear();
  dispatchUsernameChanged({ account_id: "alice", username: "alice-renamed" });
  await new Promise((done) => setTimeout(done, 0));
  expect(resolveUrl).not.toHaveBeenCalled();
  cancelPersonalUrlNavigation();
  dispatchUsernameChanged({ account_id: "bob", username: "bob-renamed" });
  await new Promise((done) => setTimeout(done, 0));
  expect(resolveUrl).not.toHaveBeenCalled();
});

test("access-denied stores only the project request target, never returned content", async () => {
  resolveUrl.mockResolvedValue({
    ...artifact,
    status: "access-denied",
    project_id: "request-project",
  });
  await resolvePersonalUrl("u/bob/artifacts/notes");
  expect(page.personal_url_project_id).toBe("request-project");
  expect(page.library_project_id).toBeUndefined();
  expect(page.library_entry_id).toBeUndefined();
  expect(page.personal_url).toBe("u/bob/artifacts/notes");
});

test("login hydration preserves the owner and only then resolves as the viewer", async () => {
  viewer = undefined;
  signedIn = false;
  await resolvePersonalUrl("u/bob/artifacts/notes");
  expect(resolveUrl).not.toHaveBeenCalled();
  expect(page.personal_url).toBe("u/bob/artifacts/notes");
  viewer = "alice";
  signedIn = true;
  for (const listener of [...accountListeners]) listener();
  await new Promise((done) => setTimeout(done, 0));
  expect(resolveUrl).toHaveBeenCalledWith({ url: "/u/bob/artifacts/notes" });
  expect(page.personal_url_status).toBe("resolved");
});

test("account switching clears resolved IDs and reauthorizes the original owner's URL", async () => {
  await resolvePersonalUrl("u/bob/artifacts/notes");
  resolveUrl.mockResolvedValue({
    ...artifact,
    status: "access-denied",
    target: undefined,
  });
  viewer = "charlie";
  for (const listener of [...accountListeners]) listener();
  expect(page.library_project_id).toBeUndefined();
  expect(page.personal_url_status).toBe("loading");
  await new Promise((done) => setTimeout(done, 0));
  expect(resolveUrl.mock.calls).toEqual([
    [{ url: "/u/bob/artifacts/notes" }],
    [{ url: "/u/bob/artifacts/notes" }],
  ]);
  expect(page.personal_url_status).toBe("error");
  expect(page.personal_url).toBe("u/bob/artifacts/notes");
});

test.each(["navigation", "account", "client"])(
  "a stale response after %s cannot apply IDs or rewrite history",
  async (mode) => {
    let finish!: (result: ResolvedPersonalUrl) => void;
    resolveUrl.mockReturnValue(
      new Promise((done) => {
        finish = done;
      }),
    );
    const pending = resolvePersonalUrl("u/bob/artifacts/notes");
    await new Promise((done) => setTimeout(done, 0));
    if (mode === "navigation") cancelPersonalUrlNavigation();
    else if (mode === "account") viewer = "charlie";
    else webappClient.conat_client = { ...client };
    setState.mockClear();
    finish(artifact);
    await pending;
    expect(setState).not.toHaveBeenCalled();
    expect(replaceUrl).not.toHaveBeenCalled();
  },
);

test("leave-and-return and A-B-A account changes fence older requests", async () => {
  let finish!: (result: ResolvedPersonalUrl) => void;
  resolveUrl.mockReturnValueOnce(
    new Promise((done) => {
      finish = done;
    }),
  );
  const older = resolvePersonalUrl("u/bob/artifacts/notes");
  await new Promise((done) => setTimeout(done, 0));
  viewer = "charlie";
  for (const listener of [...accountListeners]) listener();
  viewer = "alice";
  for (const listener of [...accountListeners]) listener();
  await resolvePersonalUrl("u/bob/artifacts/notes");
  setState.mockClear();
  replaceUrl.mockClear();
  finish({
    ...artifact,
    target: { kind: "artifact", project_id: "stale", entry_id: "stale" },
  });
  await older;
  expect(setState).not.toHaveBeenCalled();
  expect(replaceUrl).not.toHaveBeenCalled();
  expect(page.library_project_id).toBe("canonical-project");
});

test("canonical agent, chat and person IDs reuse existing selection types", () => {
  const agent: ResolvedPersonalUrl = {
    ...artifact,
    kind: "agents",
    target: { kind: "agent", project_id: "project", agent_id: "stable-agent" },
  };
  expect(personalUrlSelection(agent, "bob")).toEqual({
    active_agent_id: "stable-agent",
  });
  expect(personalUrlSelection(agent, "alice")).toMatchObject({
    collaborators_project_id: "project",
    collaborators_resource_id: "stable-agent",
    collaborators_resource_kind: "agent",
  });
  expect(
    personalUrlSelection(
      {
        ...artifact,
        kind: "chats",
        target: {
          kind: "conversation",
          project_id: "project",
          resource_id: "thread",
          resource_kind: "conversation",
        },
      },
      "alice",
    ),
  ).toMatchObject({
    collaborators_project_id: "project",
    collaborators_resource_id: "thread",
  });
  expect(
    personalUrlSelection(
      {
        ...artifact,
        kind: "people",
        target: { kind: "person", person_id: "stable-person" },
      },
      "bob",
    ),
  ).toMatchObject({
    collaborators_view: "people",
    collaborators_person_id: "stable-person",
  });
});
