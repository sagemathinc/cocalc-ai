/** @jest-environment jsdom */

import { redux, project_redux_name } from "@cocalc/frontend/app-framework";
import { set_url } from "@cocalc/frontend/history";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { PageActions } from "./actions";
import { init_store } from "./store";

jest.mock("@cocalc/frontend/app-framework", () => {
  const { AppRedux } = jest.requireActual("@cocalc/util/redux/AppRedux");
  class TestRedux extends AppRedux {
    getTable() {
      throw Error("Unexpected table access");
    }
    getProjectTable() {
      throw Error("Unexpected project table access");
    }
    removeTable() {
      throw Error("Unexpected table mutation");
    }
  }
  return {
    redux: new TestRedux(),
    ...jest.requireActual("@cocalc/util/redux/Actions"),
    ...jest.requireActual("@cocalc/util/redux/Store"),
    ...jest.requireActual("@cocalc/util/redux/name"),
  };
});
jest.mock("@cocalc/frontend/client/handle-target", () => ({
  __esModule: true,
  default: "projects",
}));
jest.mock("@cocalc/frontend/browser", () => ({ set_window_title: jest.fn() }));
jest.mock("@cocalc/frontend/history", () => ({
  set_url: jest.fn(),
  update_params: jest.fn(),
}));
jest.mock("@cocalc/frontend/i18n", () => ({
  labels: {
    project: { defaultMessage: "Project" },
    projects: { defaultMessage: "Projects" },
    account: { defaultMessage: "Account" },
    admin: { defaultMessage: "Admin" },
    notifications: { defaultMessage: "Notifications" },
  },
}));
jest.mock("@cocalc/frontend/i18n/get-intl", () => ({
  getIntl: async () => ({ formatMessage: (value) => value.defaultMessage }),
}));
jest.mock("@cocalc/frontend/misc/fullscreen", () => ({
  exitFullscreen: jest.fn(),
  isFullscreen: jest.fn(),
  requestFullscreen: jest.fn(),
}));
jest.mock("@cocalc/frontend/project/websocket/connect", () => ({
  disconnect_from_project: jest.fn(),
}));
jest.mock("@cocalc/frontend/session", () => ({ session_manager: jest.fn() }));
jest.mock("@cocalc/frontend/app-framework/project-runtime", () => ({
  ensureProjectReduxRuntime: jest.fn(async () => undefined),
}));
jest.mock("@cocalc/frontend/project/reduced-runtime", () => ({
  hasReducedProjectState: () => false,
  getReducedProjectState: () => undefined,
}));

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const C = "00000000-0000-4000-8000-000000000003";
const names = [
  "page",
  "projects",
  "account",
  "customize",
  ...[A, B, C].map((id) => project_redux_name(id)),
];
let actions: PageActions;
let accountPush: jest.Mock;
let projectActions: Record<
  string,
  { show: jest.Mock; hide: jest.Mock; push_state: jest.Mock }
>;
const page = () => redux.getStore("page") as any;
const projects = () => redux.getStore("projects");

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(ensureProjectReduxRuntime).mockResolvedValue(undefined);
  init_store();
  actions = redux.createActions("page", PageActions);
  redux.createStore("customize", undefined, {});
  redux.createStore("account", undefined, {});
  accountPush = jest.fn();
  Object.assign(redux.createActions("account"), { push_state: accountPush });
  redux.createStore("projects", undefined, {
    open_projects: [A, B],
    project_map: {
      [A]: { title: "Alpha" },
      [B]: { title: "Beta" },
      [C]: { title: "Gamma" },
    },
  });
  const pa = redux.createActions("projects");
  Object.assign(pa, {
    set_project_closed: jest.fn((id) =>
      pa.setState({
        open_projects: projects()
          .get("open_projects")
          .filter((value) => value !== id),
      }),
    ),
    fetch_public_project_title: jest.fn(),
  });
  projectActions = {};
  for (const id of [A, B, C]) {
    const name = project_redux_name(id);
    redux.createStore(name, undefined, {});
    projectActions[id] = {
      show: jest.fn(),
      hide: jest.fn(),
      push_state: jest.fn(),
    };
    Object.assign(redux.createActions(name), projectActions[id]);
  }
});

afterEach(() => {
  for (const name of names) {
    redux.removeActions(name);
    redux.removeStore(name);
  }
});

describe("project context across global navigation", () => {
  it.each(["account", "admin", "docs", "projects", "notifications"])(
    "remembers the selected project while opening %s",
    async (route) => {
      await actions.set_active_tab(B);
      await actions.set_active_tab(route);
      expect(page().get("active_top_tab")).toBe(route);
      expect(page().get("last_project_tab")).toBe(B);
      expect(projectActions[A].show).not.toHaveBeenCalled();
      expect(projectActions[A].push_state).not.toHaveBeenCalled();
      expect(projectActions[B].hide).toHaveBeenCalledTimes(1);
      if (route === "account") expect(accountPush).toHaveBeenCalledTimes(1);
      if (route === "admin") expect(set_url).toHaveBeenLastCalledWith("/admin");
    },
  );

  it("retains context across repeated Account/Admin visits and updates on explicit project navigation", async () => {
    await actions.set_active_tab(B);
    await actions.set_active_tab("account");
    await actions.set_active_tab("admin");
    expect(page().get("last_project_tab")).toBe(B);
    await actions.set_active_tab(A);
    await actions.set_active_tab("account");
    expect(page().get("last_project_tab")).toBe(A);
  });

  it("updates context on history navigation without pushing another history entry", async () => {
    await actions.set_active_tab(B, false);
    await actions.set_active_tab("account", false);
    expect(page().get("last_project_tab")).toBe(B);
    expect(accountPush).not.toHaveBeenCalled();
    expect(projectActions[B].push_state).not.toHaveBeenCalled();
    expect(set_url).not.toHaveBeenCalled();
  });

  it("commits active route and remembered project together after runtime loading", async () => {
    let finish!: () => void;
    jest.mocked(ensureProjectReduxRuntime).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const pending = actions.set_active_tab(B);
    expect(page().get("active_top_tab")).toBe("projects");
    expect(page().get("last_project_tab")).toBeUndefined();
    finish();
    await pending;
    expect(page().get("active_top_tab")).toBe(B);
    expect(page().get("last_project_tab")).toBe(B);
  });

  it.each(["account", "admin"])(
    "replaces closed context without leaving %s or resurrecting it on background reopen",
    async (route) => {
      await actions.set_active_tab(B);
      await actions.set_active_tab(route);
      actions.close_project_tab(B);
      expect(page().get("active_top_tab")).toBe(route);
      expect(page().get("last_project_tab")).toBe(A);
      expect(projects().get("open_projects").toJS()).toEqual([A]);
      redux.getActions("projects").setState({ open_projects: [A, B] });
      expect(page().get("last_project_tab")).toBe(A);
      expect(projectActions[A].show).not.toHaveBeenCalled();
    },
  );

  it("keeps context when an unrelated project is closed", async () => {
    await actions.set_active_tab(B);
    await actions.set_active_tab("account");
    actions.close_project_tab(A);
    expect(page().get("last_project_tab")).toBe(B);
  });

  it("forgets reconciliation-removed context without changing the global route", async () => {
    await actions.set_active_tab(B);
    await actions.set_active_tab("account");
    actions.forget_project_context(B);
    expect(page().get("last_project_tab")).toBe(A);
    expect(page().get("active_top_tab")).toBe("account");
    redux.getActions("projects").setState({ open_projects: [A, B] });
    expect(page().get("last_project_tab")).toBe(A);
  });

  it("clears context when the last open project closes on Account", async () => {
    await actions.set_active_tab(B);
    await actions.set_active_tab("account");
    actions.close_project_tab(A);
    actions.close_project_tab(B);
    expect(page().get("active_top_tab")).toBe("account");
    expect(page().get("last_project_tab")).toBeUndefined();
    expect(projects().get("open_projects").size).toBe(0);
  });

  it("preserves existing adjacent-project navigation when closing the active project", async () => {
    await actions.set_active_tab(B);
    const spy = jest.spyOn(actions, "set_active_tab");
    actions.close_project_tab(B);
    await spy.mock.results[0].value;
    expect(page().get("active_top_tab")).toBe(A);
    expect(page().get("last_project_tab")).toBe(A);
    spy.mockRestore();
  });

  it("does not change state when asked to close a project that is not open", async () => {
    await actions.set_active_tab(B);
    await actions.set_active_tab("account");
    actions.close_project_tab(C);
    expect(page().get("active_top_tab")).toBe("account");
    expect(page().get("last_project_tab")).toBe(B);
    expect(projects().get("open_projects").toJS()).toEqual([A, B]);
  });

  it("clears context when closing the only active project", async () => {
    redux.getActions("projects").setState({ open_projects: [B] });
    await actions.set_active_tab(B);
    const spy = jest.spyOn(actions, "set_active_tab");
    actions.close_project_tab(B);
    await spy.mock.results[0].value;
    expect(page().get("active_top_tab")).toBe("projects");
    expect(page().get("last_project_tab")).toBeUndefined();
    expect(projects().get("open_projects").size).toBe(0);
    spy.mockRestore();
  });

  it("leaves both state fields unchanged when runtime loading fails", async () => {
    await actions.set_active_tab(A);
    jest
      .mocked(ensureProjectReduxRuntime)
      .mockRejectedValueOnce(new Error("Synthetic load failure"));
    await expect(actions.set_active_tab(B)).rejects.toThrow(
      "Synthetic load failure",
    );
    expect(page().get("active_top_tab")).toBe(A);
    expect(page().get("last_project_tab")).toBe(A);
  });
});
