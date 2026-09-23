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
const webappClient = {
  is_signed_in: jest.fn(() => false),
};

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
} from "./history";
import { authViewUrl, signedInRedirectUrl } from "./auth/util";
import { getPageUrlPath, parsePageTarget } from "./page-routing";

describe("load_target", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pageActions.setState.mockReset();
    delete (globalThis as any).__cocalc_public_app;
    mockRedux.getStore.mockImplementation((name: string) => {
      if (name === "account") {
        return accountStore;
      }
      return {};
    });
    webappClient.is_signed_in.mockReturnValue(false);
    accountStore.get.mockImplementation((key: string) => {
      if (key === "is_logged_in") {
        return true;
      }
      return undefined;
    });
  });

  it("keeps the conversation across Library detail, root, and browser back navigation", () => {
    const state: Record<string, unknown> = {};
    pageActions.setState.mockImplementation((update) =>
      Object.assign(state, update),
    );
    load_target("agents/reviewer");
    load_target("library/project-1/entry-1");
    expect(state).toMatchObject({
      active_agent_id: "reviewer",
      active_agent_name: "reviewer",
      library_open: true,
      library_project_id: "project-1",
      library_entry_id: "entry-1",
    });
    load_target("library");
    expect(state.library_project_id).toBeUndefined();
    expect(state.library_entry_id).toBeUndefined();
    const pushState = jest.spyOn(window.history, "pushState");
    for (const path of [
      "/library/project-1/entry-1",
      "/agents/reviewer",
      "/library",
    ]) {
      window.history.replaceState({}, "", path);
      window.onpopstate?.(new PopStateEvent("popstate"));
      expect(state.library_open).toBe(path.startsWith("/library"));
      expect(state.active_agent_id).toBe("reviewer");
      expect(state.active_agent_name).toBe("reviewer");
      expect(pageActions.set_active_tab).toHaveBeenLastCalledWith(
        "agents",
        false,
      );
    }
    expect(pushState).not.toHaveBeenCalled();
    pushState.mockRestore();
    expect(projectsActions.load_target).not.toHaveBeenCalled();
  });

  it.each(["/library", "/library/project-1/entry-1"])(
    "preserves Forward to %s when the workspace rewrites the current agent URL after Back",
    async (libraryPath) => {
      mockRedux.getStore.mockImplementation((name: string) =>
        name === "page" ? { get: () => undefined } : accountStore,
      );
      window.history.replaceState({}, "", "/projects?view=grid#details");
      set_url("/agents/reviewer");
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
          "/agents/reviewer?view=grid#details",
        );

        // useWorkspaceRoute synchronizes the selected agent after popstate.
        set_url("/agents/reviewer");
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
      window.history.replaceState({}, "", "/agents/reviewer?view=grid#details");
      const pushState = jest.spyOn(window.history, "pushState");
      try {
        set_url_with_search("/agents/reviewer", search, hash);
        expect(pushState).toHaveBeenCalledTimes(1);
        expect(location.pathname + location.search + location.hash).toBe(
          `/agents/reviewer${search}${hash}`,
        );
        set_url_with_search("/agents/reviewer", search, hash);
        expect(pushState).toHaveBeenCalledTimes(1);
      } finally {
        pushState.mockRestore();
      }
    },
  );

  it.each(["agents", "agents/new", "agents/another"])(
    "clears Library state on %s",
    (target) => {
      load_target("library/project-1/entry-1");
      load_target(target);
      expect(pageActions.setState).toHaveBeenLastCalledWith({
        library_open: false,
        library_project_id: undefined,
        library_entry_id: undefined,
        active_agent_id: target.split("/")[1],
        active_agent_name: target.split("/")[1],
      });
    },
  );

  it.each([
    "library/bad-project",
    "library/project/entry/extra",
    "library//entry",
  ])("never opens a project for malformed Library route %s", (target) => {
    load_target(target);
    expect(pageActions.set_active_tab).toHaveBeenLastCalledWith("agents", true);
    expect(projectsActions.load_target).not.toHaveBeenCalled();
    expect(pageActions.setState).toHaveBeenCalledWith({
      library_open: true,
      library_project_id: target.split("/")[1],
      library_entry_id: target.split("/").slice(2).join("/") || undefined,
    });
  });

  it("keeps the full Library return URL while requiring account login", () => {
    const target = "/library/project-1/entry-1?view=grid#details";
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
      library_open: true,
      library_project_id: "project-1",
      library_entry_id: "entry-1",
    });
    expect(projectsActions.load_target).not.toHaveBeenCalled();
  });

  it.each([
    "library/project/entry",
    "library//project/entry",
    "library/project/entry/extra",
  ])(
    "preserves Library path structure and full URL on history updates: %s",
    (target) => {
      window.history.replaceState({}, "", "/agents/reviewer?view=grid#details");
      mockRedux.getStore.mockImplementation((name: string) =>
        name === "page" ? { get: () => undefined } : accountStore,
      );
      set_url(getPageUrlPath(parsePageTarget(target)));
      expect(location.pathname + location.search + location.hash).toBe(
        `/${target}?view=grid#details`,
      );
      window.onpopstate?.(new PopStateEvent("popstate"));
      expect(pageActions.setState).toHaveBeenLastCalledWith({
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
