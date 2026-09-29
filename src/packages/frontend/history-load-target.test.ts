/** @jest-environment jsdom */

const pageActions = {
  set_active_tab: jest.fn(),
  setState: jest.fn(),
};
const accountActions = {
  setState: jest.fn(),
  set_active_tab: jest.fn(),
  push_state: jest.fn(),
  setFragment: jest.fn(),
};
const projectsActions = {
  load_target: jest.fn(),
};
const mentionsActions = {
  set_filter: jest.fn(),
};
const mockResolveUrl = jest.fn();
let mockPageState: Record<string, unknown> = {};
const webappClient = {
  is_signed_in: jest.fn(() => false),
  conat_client: { hub: { personalUrls: { resolveUrl: mockResolveUrl } } },
};
const mockResolvePersonAlias = jest.fn();
const mockResolveChatAlias = jest.fn();
jest.mock("./collaborators/workspace-api", () => ({
  boundCollaboratorsApi: () => ({
    resolvePersonAlias: mockResolvePersonAlias,
    resolveChatAlias: mockResolveChatAlias,
  }),
}));

const accountStore = {
  get: jest.fn((key: string) => {
    if (key === "is_logged_in") {
      return true;
    }
    return undefined;
  }),
};

const mockRedux = {
  getStore: jest.fn((name: string) => {
    if (name === "account") {
      return accountStore;
    }
    return {};
  }),
  getActions: jest.fn((name: string) => {
    switch (name) {
      case "page":
        return pageActions;
      case "account":
        return accountActions;
      case "projects":
        return projectsActions;
      case "mentions":
        return mentionsActions;
      default:
        throw Error(`unexpected actions store ${name}`);
    }
  }),
};

const fragment = {
  get: jest.fn(() => ({ line: "7" })),
  decode: jest.fn((hash: string) => ({ hash })),
};

const getNotificationFilterFromFragment = jest.fn((hash: string) => ({
  filter: "mentions",
  id: hash === "thread" ? "notif-1" : "notif-default",
}));
const handoffToPrivateProjectApp = jest.fn(async () => undefined);
const alertMessage = jest.fn();

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: mockRedux,
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: webappClient,
}));

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: (...args: unknown[]) => alertMessage(...args),
}));

jest.mock("@cocalc/frontend/project/private-app-handoff", () => ({
  handoffToPrivateProjectApp: (...args: unknown[]) =>
    handoffToPrivateProjectApp(...args),
}));

jest.mock("@cocalc/frontend/misc/fragment-id", () => ({
  __esModule: true,
  default: fragment,
}));

jest.mock("./notifications/fragment", () => ({
  getNotificationFilterFromFragment: (hash: string) =>
    getNotificationFilterFromFragment(hash),
}));

import {
  load_target,
  set_url,
  set_url_with_search,
  update_params,
  replace_url,
} from "./history";
import { authViewUrl, signedInRedirectUrl } from "./auth/util";
import { getPageUrlPath, parsePageTarget } from "./page-routing";
import { closedCollaboratorsState } from "./collaborators/navigation";

describe("load_target", () => {
  it("preserves a notification invitation UUID through landing and canonical URL updates", () => {
    const previous = location.pathname + location.search + location.hash;
    const invitationId = "44444444-4444-4444-8444-444444444444";
    const target = `people/invites/?invitation_id=${invitationId}`;
    try {
      // Notification A links and emails perform normal browser navigation: the
      // query is already in location before account-home routing initializes.
      window.history.replaceState({}, "", `/${target}`);
      load_target(target, false, false);
      expect(mockPageState).toMatchObject({
        collaborators_view: "invites",
        collaborators_route_error: undefined,
      });
      set_url(getPageUrlPath(parsePageTarget(target)));
      expect(new URL(location.href).searchParams.get("invitation_id")).toBe(
        invitationId,
      );
      expect(projectsActions.load_target).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, "", previous);
    }
  });

  it("restores contact, invite, and account selections on Back/Forward without conflating identities", () => {
    const contact = "33333333-3333-4333-8333-333333333333";
    const push = jest.spyOn(window.history, "pushState");
    try {
      for (const [path, view, contactId, personId] of [
        [
          `/people/collaborators/contact/${contact}/`,
          "people",
          contact,
          undefined,
        ],
        [`/people/invites/contact/${contact}/`, "invites", contact, undefined],
        ["/people/collaborators/person/bob/", "people", undefined, "bob"],
        [`/people/invites/contact/${contact}/`, "invites", contact, undefined],
        ["/people/invites/", "invites", undefined, undefined],
      ]) {
        window.history.replaceState({}, "", path!);
        window.onpopstate?.(new PopStateEvent("popstate"));
        expect(mockPageState).toMatchObject({
          collaborators_view: view,
          collaborators_contact_id: contactId,
          collaborators_person_id: personId,
          collaborators_route_error: undefined,
        });
        expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
          "agents",
          false,
        );
      }
      expect(push).not.toHaveBeenCalled();
      load_target("agents");
      expect(mockPageState.collaborators_contact_id).toBeUndefined();
    } finally {
      push.mockRestore();
    }
  });

  it("canonical alias updates replace the URL without loading a target or losing parameters", () => {
    mockRedux.getStore.mockImplementation((name: string) =>
      name === "page" ? { get: () => undefined } : accountStore,
    );
    window.history.replaceState(
      {},
      "",
      "/people/people/person/id?view=grid#details",
    );
    const push = jest.spyOn(window.history, "pushState");
    const length = window.history.length;
    replace_url("/u/bob/people/alice");
    expect(location.pathname + location.search + location.hash).toBe(
      "/u/bob/people/alice?view=grid#details",
    );
    expect(window.history.length).toBe(length);
    expect(push).not.toHaveBeenCalled();
    expect(pageActions.setState).not.toHaveBeenCalled();
    push.mockRestore();
  });
  it("keeps a personal alias URL through login and resolves it to a stable ID without a history push", async () => {
    const path = "/u/bob/people/alice?view=grid#details";
    window.history.replaceState({}, "", path);
    accountStore.get.mockReturnValue(false);
    load_target(path, false, false);
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
      "account",
      false,
    );
    expect(mockResolveUrl).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe(path);
    accountStore.get.mockImplementation((key) =>
      key === "account_id" ? "signed-in-account" : key === "is_logged_in",
    );
    mockResolveUrl.mockResolvedValue({
      owner: { account_id: "bob", username: "bob", redirect: false },
      kind: "people",
      alias: "alice",
      status: "resolved",
      canonical_path: "/u/bob/people/alice",
      target: { kind: "person", person_id: "stable-person-id" },
    });
    const push = jest.spyOn(window.history, "pushState");
    load_target(path, false, false);
    await new Promise((done) => setTimeout(done, 0));
    expect(pageActions.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        collaborators_person_id: "stable-person-id",
        personal_url: "u/bob/people/alice",
        personal_url_status: "resolved",
      }),
    );
    expect(push).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe(path);
    push.mockRestore();
  });
  it("merges copied invitation queries into the address bar and removes stale IDs", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    window.history.replaceState(
      {},
      "",
      `/people/invites?invitation_id=${first}&test=keep`,
    );
    set_url(`/people/invites?invitation_id=${second}`, "");
    expect(
      new URLSearchParams(location.search).getAll("invitation_id"),
    ).toEqual([second]);
    expect(location.href.split("?")).toHaveLength(2);
    expect(
      parsePageTarget(location.pathname.slice(1) + location.search),
    ).toMatchObject({
      collaborators: { view: "invites", invitationId: second },
    });
    set_url("/people/invites", "");
    expect(new URLSearchParams(location.search).has("invitation_id")).toBe(
      false,
    );
    set_url(`/people/invites?invitation_id=${first}`, "");
    set_url("/people/collaborators", "");
    expect(new URLSearchParams(location.search).has("invitation_id")).toBe(
      false,
    );
  });

  it("restores successive invitation deep links on Back/Forward without stale selection or history pushes", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const push = jest.spyOn(window.history, "pushState");
    try {
      for (const id of [first, second, first, second, undefined]) {
        const path = `/people/invites${id ? `?invitation_id=${id}` : ""}`;
        window.history.replaceState({}, "", path);
        window.dispatchEvent(new PopStateEvent("popstate"));
        expect(mockPageState.collaborators_invitation_id).toBe(id);
        expect(mockPageState.collaborators_view).toBe("invites");
        expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
          "agents",
          false,
        );
        expect(location.pathname + location.search).toBe(path);
      }
      load_target(`/people/collaborators?invitation_id=${first}`, false, false);
      expect(mockPageState.collaborators_invitation_id).toBeUndefined();
      expect(push).not.toHaveBeenCalled();
    } finally {
      push.mockRestore();
    }
  });

  it("preserves the active agent across People browsing and back navigation", () => {
    const state: Record<string, unknown> = {};
    pageActions.setState.mockImplementation((update) =>
      Object.assign(state, update),
    );
    load_target("agents/11111111-1111-4111-8111-111111111111");
    load_target(
      "people/conversations/project/project-1/resource/conversation/thread-1",
    );
    expect(state).toMatchObject({
      active_agent_id: "11111111-1111-4111-8111-111111111111",
      collaborators_open: true,
      library_open: false,
      collaborators_project_id: "project-1",
      collaborators_resource_id: "thread-1",
    });
    load_target("artifacts");
    expect(state.collaborators_open).toBe(false);
    expect(state.collaborators_resource_id).toBeUndefined();
    load_target("people/people/person/person-1", false, false);
    expect(state.active_agent_id).toBe("11111111-1111-4111-8111-111111111111");
    expect(state.library_open).toBe(false);
    expect(state.collaborators_person_id).toBe("person-1");
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
      "agents",
      false,
    );
    load_target("agents/11111111-1111-4111-8111-111111111111");
    expect(state.collaborators_open).toBe(false);
  });
  beforeEach(() => {
    jest.clearAllMocks();
    pageActions.setState.mockReset();
    mockPageState = {};
    pageActions.setState.mockImplementation((update) =>
      Object.assign(mockPageState, update),
    );
    mockResolveUrl.mockReset();
    delete (globalThis as any).__cocalc_public_app;
    mockRedux.getStore.mockImplementation((name: string) => {
      if (name === "account") {
        return accountStore;
      }
      return { get: (key) => mockPageState[key] };
    });
    webappClient.is_signed_in.mockReturnValue(false);
    accountStore.get.mockImplementation((key: string) => {
      if (key === "is_logged_in") {
        return true;
      }
      return undefined;
    });
  });

  it("keeps the conversation across Artifacts detail, root, and browser back navigation", () => {
    const state: Record<string, unknown> = {};
    pageActions.setState.mockImplementation((update) =>
      Object.assign(state, update),
    );
    load_target("agents/11111111-1111-4111-8111-111111111111");
    load_target("artifacts/project-1/entry-1");
    expect(state).toMatchObject({
      active_agent_id: "11111111-1111-4111-8111-111111111111",
      active_agent_name: undefined,
      library_open: true,
      library_project_id: "project-1",
      library_entry_id: "entry-1",
    });
    load_target("artifacts");
    expect(state.library_project_id).toBeUndefined();
    expect(state.library_entry_id).toBeUndefined();
    const pushState = jest.spyOn(window.history, "pushState");
    for (const path of [
      "/artifacts/project-1/entry-1",
      "/agents/11111111-1111-4111-8111-111111111111",
      "/artifacts",
    ]) {
      window.history.replaceState({}, "", path);
      window.onpopstate?.(new PopStateEvent("popstate"));
      expect(state.library_open).toBe(path.startsWith("/artifacts"));
      expect(state.active_agent_id).toBe(
        "11111111-1111-4111-8111-111111111111",
      );
      expect(state.active_agent_name).toBeUndefined();
      expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
        "agents",
        false,
      );
    }
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
    expect(projectsActions.load_target).not.toHaveBeenCalled();
  });

  it.each(["/artifacts", "/artifacts/project-1/entry-1"])(
    "preserves Forward to %s when the workspace rewrites the current agent URL after Back",
    async (libraryPath) => {
      mockRedux.getStore.mockImplementation((name: string) =>
        name === "page" ? { get: () => undefined } : accountStore,
      );
      window.history.replaceState({}, "", "/projects?view=grid#details");
      set_url("/agents/11111111-1111-4111-8111-111111111111");
      set_url(libraryPath);
      const historyLength = window.history.length;
      const pushState = jest.spyOn(window.history, "pushState");
      try {
        const back = new Promise<void>((resolve) =>
          window.addEventListener("popstate", () => resolve(), { once: true }),
        );
        window.history.back();
        await back;
        expect(location.pathname + location.search + location.hash).toBe(
          "/agents/11111111-1111-4111-8111-111111111111?view=grid#details",
        );

        // useWorkspaceRoute synchronizes the selected agent after popstate.
        set_url("/agents/11111111-1111-4111-8111-111111111111");
        update_params();
        expect(pushState).not.toHaveBeenCalled();
        expect(window.history.length).toBe(historyLength);

        const forward = new Promise<void>((resolve) =>
          window.addEventListener("popstate", () => resolve(), { once: true }),
        );
        window.history.forward();
        await forward;
        expect(location.pathname + location.search + location.hash).toBe(
          `${libraryPath}?view=grid#details`,
        );
        expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
          "agents",
          false,
        );
        expect(pushState).not.toHaveBeenCalled();
      } finally {
        pushState.mockRestore();
      }
    },
  );

  it.each([
    ["?view=list", "#details"],
    ["?view=grid", "#preview"],
  ])(
    "pushes a changed search or fragment on the same path (%s%s)",
    (search, hash) => {
      mockRedux.getStore.mockImplementation((name: string) =>
        name === "page" ? { get: () => undefined } : accountStore,
      );
      window.history.replaceState(
        {},
        "",
        "/agents/11111111-1111-4111-8111-111111111111?view=grid#details",
      );
      const pushState = jest.spyOn(window.history, "pushState");
      try {
        set_url_with_search(
          "/agents/11111111-1111-4111-8111-111111111111",
          search,
          hash,
        );
        expect(pushState).toHaveBeenCalledTimes(1);
        expect(location.pathname + location.search + location.hash).toBe(
          `/agents/11111111-1111-4111-8111-111111111111${search}${hash}`,
        );
        set_url_with_search(
          "/agents/11111111-1111-4111-8111-111111111111",
          search,
          hash,
        );
        expect(pushState).toHaveBeenCalledTimes(1);
      } finally {
        pushState.mockRestore();
      }
    },
  );

  it.each([
    "agents",
    "agents/new",
    "agents/22222222-2222-4222-8222-222222222222",
  ])("clears Artifacts state on %s", (target) => {
    load_target("artifacts/project-1/entry-1");
    load_target(target);
    expect(pageActions.setState).toHaveBeenLastCalledWith({
      ...closedCollaboratorsState,
      library_open: false,
      library_project_id: undefined,
      library_entry_id: undefined,
      active_agent_id: target.split("/")[1],
      active_agent_name: target === "agents/new" ? "new" : undefined,
    });
  });

  it.each([
    "artifacts/bad-project",
    "artifacts/project/entry/extra",
    "artifacts//entry",
  ])("never opens a project for malformed Artifacts route %s", (target) => {
    load_target(target);
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith("agents", true);
    expect(projectsActions.load_target).not.toHaveBeenCalled();
    expect(pageActions.setState).toHaveBeenCalledWith({
      ...closedCollaboratorsState,
      library_open: true,
      library_project_id: target.split("/")[1],
      library_entry_id: target.split("/").slice(2).join("/") || undefined,
    });
  });

  it("keeps the full Artifacts return URL while requiring account login", () => {
    const target = "/artifacts/project-1/entry-1?view=grid#details";
    window.history.replaceState({}, "", target);
    accountStore.get.mockReturnValue(false);
    load_target(target);
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
      "account",
      false,
    );
    expect(pageActions.setState).not.toHaveBeenCalled();
    expect(location.pathname + location.search + location.hash).toBe(target);
    const search = `?target=${encodeURIComponent(target)}`;
    expect(signedInRedirectUrl(search)).toBe(target);
    expect(authViewUrl("sign-up", search)).toBe(`/auth/sign-up${search}`);

    // A signed-in client may precede account store hydration after login.
    webappClient.is_signed_in.mockReturnValue(true);
    load_target(target, false, false);
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
      "agents",
      false,
    );
    expect(pageActions.setState).toHaveBeenLastCalledWith({
      ...closedCollaboratorsState,
      library_open: true,
      library_project_id: "project-1",
      library_entry_id: "entry-1",
    });
    expect(projectsActions.load_target).not.toHaveBeenCalled();
  });

  it.each([
    "artifacts/project/entry",
    "artifacts//project/entry",
    "artifacts/project/entry/extra",
  ])(
    "preserves Artifacts path structure and full URL on history updates: %s",
    (target) => {
      window.history.replaceState(
        {},
        "",
        "/agents/11111111-1111-4111-8111-111111111111?view=grid#details",
      );
      mockRedux.getStore.mockImplementation((name: string) =>
        name === "page" ? { get: () => undefined } : accountStore,
      );
      set_url(getPageUrlPath(parsePageTarget(target)));
      expect(location.pathname + location.search + location.hash).toBe(
        `/${target}?view=grid#details`,
      );
      window.onpopstate?.(new PopStateEvent("popstate"));
      expect(pageActions.setState).toHaveBeenLastCalledWith({
        ...closedCollaboratorsState,
        library_open: true,
        library_project_id: target.split("/")[1],
        library_entry_id: target.split("/").slice(2).join("/"),
      });
      expect(projectsActions.load_target).not.toHaveBeenCalled();
    },
  );

  it("routes settings targets through account route state", () => {
    load_target("settings/payment-methods", false, false);

    expect(pageActions.set_active_tab).toHaveBeenCalledWith("account", false);
    expect(accountActions.setState).toHaveBeenCalledWith({
      active_page: "payment-methods",
    });
  });

  it("routes project targets through projects actions", () => {
    load_target("projects/project-1/files/work.txt", true, false);

    expect(projectsActions.load_target).toHaveBeenCalledWith(
      "project-1/files/work.txt",
      true,
      true,
      false,
      { line: "7" },
    );
  });

  it("hands private app targets off before opening the project", () => {
    load_target("projects/project-1/private-app/cocalc-dev-main", true, false);

    expect(handoffToPrivateProjectApp).toHaveBeenCalledWith({
      projectId: "project-1",
      appId: "cocalc-dev-main",
    });
    expect(projectsActions.load_target).not.toHaveBeenCalled();
  });

  it("shows private app handoff failures on the Servers page", async () => {
    handoffToPrivateProjectApp.mockRejectedValueOnce(
      new Error("hostname unavailable"),
    );

    load_target("projects/project-1/private-app/cocalc-dev-main", true, false);
    await Promise.resolve();

    expect(alertMessage).toHaveBeenCalledWith({
      type: "error",
      message:
        "Unable to open private project app: Error: hostname unavailable",
    });
    expect(projectsActions.load_target).toHaveBeenCalledWith(
      "project-1/servers",
      true,
      true,
      false,
      { line: "7" },
    );
  });

  it("does not misroute project targets while account store login state is catching up", () => {
    accountStore.get.mockImplementation((key: string) => {
      if (key === "is_logged_in") {
        return false;
      }
      return undefined;
    });
    webappClient.is_signed_in.mockReturnValue(true);

    load_target("projects/project-1/files", true, false);

    expect(pageActions.set_active_tab).not.toHaveBeenCalledWith(
      "account",
      false,
    );
    expect(projectsActions.load_target).toHaveBeenCalledWith(
      "project-1/files",
      true,
      true,
      false,
      { line: "7" },
    );
  });

  it("handles ssh and notifications through the shared page route model", () => {
    load_target("ssh", false, false);
    expect(pageActions.set_active_tab).toHaveBeenCalledWith("ssh", false);

    load_target("notifications#thread", false, false);
    expect(getNotificationFilterFromFragment).toHaveBeenCalledWith("thread");
    expect(mentionsActions.set_filter).toHaveBeenCalledWith(
      "mentions",
      "notif-1",
    );
    expect(pageActions.set_active_tab).toHaveBeenCalledWith(
      "notifications",
      false,
    );
  });

  it("ignores browser popstate events while the public app owns routing", () => {
    (globalThis as any).__cocalc_public_app = true;
    window.history.replaceState({}, "", "/docs");
    mockRedux.getStore.mockImplementation(() => undefined);

    expect(() => {
      window.onpopstate?.(new PopStateEvent("popstate"));
    }).not.toThrow();

    expect(mockRedux.getActions).not.toHaveBeenCalled();
  });
});
