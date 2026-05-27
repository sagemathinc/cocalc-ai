/** @jest-environment jsdom */

const mockSetPageActiveTab = jest.fn();
const mockSetPageState = jest.fn();
const mockSetProjectActiveTab = jest.fn();
const mockSetFlyoutExpanded = jest.fn();
const mockCreateFile = jest.fn();
const mockConstructAbsolutePath = jest.fn();
const mockGetStore = jest.fn();
const mockGetProjectActions = jest.fn();
const mockGetFilenamesInCurrentDir = jest.fn();
const mockOpenFile = jest.fn();
const mockSetUrlWithSearch = jest.fn();
let mockIsAdmin = false;

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? {
            set_active_tab: mockSetPageActiveTab,
            setState: mockSetPageState,
          }
        : undefined,
    getStore: (name: string) =>
      name === "account"
        ? {
            get: (key: string) => (key === "is_admin" ? mockIsAdmin : null),
          }
        : undefined,
    getProjectActions: (projectId: string) => mockGetProjectActions(projectId),
  },
}));

jest.mock("@cocalc/frontend/history", () => ({
  set_url_with_search: (...args: any[]) => mockSetUrlWithSearch(...args),
}));

import {
  PROJECT_SECRETS_DOCS_ACTION_EVENT,
  RUNTIME_IMAGE_DOCS_ACTION_EVENT,
  listDocsAppActions,
  revealDocsAction,
} from "./docs-actions";

describe("project docs actions", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockIsAdmin = false;
    window.localStorage.clear();
    mockGetStore.mockReturnValue({
      get: (key: string) => {
        if (key === "current_path_abs") return "/work";
        if (key === "active_project_tab") return "editor-/work/notebook.ipynb";
        if (key === "open_files_order") return ["/work/notebook.ipynb"];
        return undefined;
      },
    });
    mockConstructAbsolutePath.mockImplementation(
      (name: string, currentPath: string, ext: string) =>
        `${currentPath}/${name}.${ext}`,
    );
    mockGetProjectActions.mockReturnValue({
      construct_absolute_path: mockConstructAbsolutePath,
      createFile: mockCreateFile,
      get_filenames_in_current_dir: mockGetFilenamesInCurrentDir,
      get_store: mockGetStore,
      open_file: mockOpenFile,
      set_active_tab: mockSetProjectActiveTab,
      setFlyoutExpanded: mockSetFlyoutExpanded,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("reports executable project docs actions as implemented", () => {
    const actions = listDocsAppActions({ projectId: "project-1" });
    expect(
      actions.filter((action) => action.implemented).map((action) => action.id),
    ).toEqual(
      expect.arrayContaining([
        "settings.environment.secrets",
        "project.terminal.open",
        "project.jupyter.create",
        "settings.runtime.rootfs",
        "settings.people.collaborators",
        "file.timetravel.open",
        "project.codex.open",
      ]),
    );
  });

  it("hides admin docs actions from non-admins and exposes them to admins", () => {
    expect(
      listDocsAppActions({ projectId: "project-1" }).map((action) => action.id),
    ).not.toContain("admin.users.open");

    mockIsAdmin = true;
    expect(
      listDocsAppActions({ projectId: "project-1" }).map((action) => action.id),
    ).toEqual(
      expect.arrayContaining([
        "admin.bay-ops.open",
        "admin.managed-egress.open",
        "admin.rootfs.open",
        "admin.sso.open",
        "admin.users.open",
      ]),
    );
  });

  it("opens admin sections for admin docs actions", async () => {
    mockIsAdmin = true;

    const result = await revealDocsAction({
      actionId: "admin.site-settings.open",
      projectId: "project-1",
    });

    expect(mockSetPageActiveTab).toHaveBeenCalledWith("admin", false);
    expect(mockSetPageState).toHaveBeenCalledWith({
      admin_route: { kind: "index", section: "site-settings" },
    });
    expect(mockSetUrlWithSearch).toHaveBeenCalledWith(
      "/admin/site-settings",
      "",
    );
    expect(result).toMatchObject({
      action_id: "admin.site-settings.open",
      opened: true,
      panel: "site-settings",
      project_id: "project-1",
      tab: "admin",
    });
  });

  it("opens additional admin sections for admin docs actions", async () => {
    mockIsAdmin = true;

    const result = await revealDocsAction({
      actionId: "admin.rootfs.open",
      projectId: "project-1",
    });

    expect(mockSetPageState).toHaveBeenCalledWith({
      admin_route: { kind: "index", section: "rootfs" },
    });
    expect(mockSetUrlWithSearch).toHaveBeenCalledWith("/admin/rootfs", "");
    expect(result).toMatchObject({
      action_id: "admin.rootfs.open",
      opened: true,
      panel: "rootfs",
      tab: "admin",
    });
  });

  it("opens managed egress and sso admin sections", async () => {
    mockIsAdmin = true;

    await revealDocsAction({
      actionId: "admin.managed-egress.open",
      projectId: "project-1",
    });
    expect(mockSetPageState).toHaveBeenLastCalledWith({
      admin_route: { kind: "index", section: "managed-egress" },
    });
    expect(mockSetUrlWithSearch).toHaveBeenLastCalledWith(
      "/admin/managed-egress",
      "",
    );

    await revealDocsAction({
      actionId: "admin.sso.open",
      projectId: "project-1",
    });
    expect(mockSetPageState).toHaveBeenLastCalledWith({
      admin_route: { kind: "index", section: "sso" },
    });
    expect(mockSetUrlWithSearch).toHaveBeenLastCalledWith("/admin/sso", "");
  });

  it("opens the system notice editor for admin docs actions", async () => {
    mockIsAdmin = true;

    await revealDocsAction({
      actionId: "admin.news.create-system",
      projectId: "project-1",
    });

    expect(mockSetPageState).toHaveBeenCalledWith({
      admin_route: { kind: "news-editor", id: "new" },
    });
    expect(mockSetUrlWithSearch).toHaveBeenCalledWith(
      "/admin/news/new",
      "?channel=system",
    );
  });

  it("creates and opens a default terminal file", async () => {
    const result = await revealDocsAction({
      actionId: "project.terminal.open",
      projectId: "project-1",
    });

    expect(mockSetPageActiveTab).toHaveBeenCalledWith("project-1", false);
    expect(mockCreateFile).toHaveBeenCalledWith({
      current_path: "/work",
      ext: "term",
      name: "terminal",
      switch_over: true,
    });
    expect(result).toMatchObject({
      action_id: "project.terminal.open",
      opened: true,
      path: "/work/terminal.term",
      project_id: "project-1",
    });
  });

  it("creates and opens a default notebook", async () => {
    await revealDocsAction({
      actionId: "project.jupyter.create",
      projectId: "project-1",
    });

    expect(mockCreateFile).toHaveBeenCalledWith({
      current_path: "/work",
      ext: "ipynb",
      name: "notebook",
      switch_over: true,
    });
  });

  it("avoids clobbering existing quick action filenames", async () => {
    mockGetFilenamesInCurrentDir.mockReturnValue({
      "terminal.term": true,
    });

    await revealDocsAction({
      actionId: "project.terminal.open",
      projectId: "project-1",
    });

    expect(mockCreateFile).toHaveBeenCalledWith({
      current_path: "/work",
      ext: "term",
      name: "terminal-2",
      switch_over: true,
    });
  });

  it("opens the runtime image modal in project settings", async () => {
    const events: any[] = [];
    window.addEventListener(RUNTIME_IMAGE_DOCS_ACTION_EVENT, (event) =>
      events.push((event as CustomEvent).detail),
    );

    const result = await revealDocsAction({
      actionId: "settings.runtime.rootfs",
      projectId: "project-1",
    });

    expect(events).toEqual([{ projectId: "project-1", surface: "flyout" }]);
    expect(mockSetProjectActiveTab).toHaveBeenCalledWith("settings", {
      change_history: false,
      noFocus: true,
    });
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("settings", true);
    expect(
      JSON.parse(window.localStorage.getItem("project-1::flyout")!),
    ).toMatchObject({
      expanded: "settings",
      settings: ["environment"],
    });
    expect(result).toMatchObject({
      action_id: "settings.runtime.rootfs",
      opened: true,
      panel: "runtime-image",
      tab: "settings",
    });
  });

  it("targets the project secrets docs event at the settings flyout", async () => {
    const events: any[] = [];
    window.addEventListener(PROJECT_SECRETS_DOCS_ACTION_EVENT, (event) =>
      events.push((event as CustomEvent).detail),
    );

    await revealDocsAction({
      actionId: "settings.environment.secrets",
      projectId: "project-1",
    });

    expect(events[0]).toEqual({ projectId: "project-1", surface: "flyout" });
  });

  it("opens the people settings panel", async () => {
    const result = await revealDocsAction({
      actionId: "settings.people.collaborators",
      projectId: "project-1",
    });

    expect(mockSetProjectActiveTab).toHaveBeenCalledWith("settings", {
      change_history: false,
      noFocus: true,
    });
    expect(
      JSON.parse(window.localStorage.getItem("project-1::flyout")!),
    ).toMatchObject({
      expanded: "settings",
      settings: ["people"],
    });
    expect(result).toMatchObject({
      action_id: "settings.people.collaborators",
      opened: true,
      panel: "people",
      tab: "settings",
    });
  });

  it("opens TimeTravel for the active file", async () => {
    const result = await revealDocsAction({
      actionId: "file.timetravel.open",
      projectId: "project-1",
    });

    expect(mockOpenFile).toHaveBeenCalledWith({
      foreground: true,
      path: "/work/.notebook.ipynb.time-travel",
    });
    expect(result).toMatchObject({
      action_id: "file.timetravel.open",
      opened: true,
      path: "/work/.notebook.ipynb.time-travel",
      source_path: "/work/notebook.ipynb",
    });
  });

  it("creates a default source file before TimeTravel when no file is open", async () => {
    mockGetStore.mockReturnValue({
      get: (key: string) => {
        if (key === "current_path_abs") return "/work";
        if (key === "active_project_tab") return "settings";
        if (key === "open_files_order") return [];
        return undefined;
      },
    });

    const result = await revealDocsAction({
      actionId: "file.timetravel.open",
      projectId: "project-1",
    });

    expect(mockCreateFile).toHaveBeenCalledWith({
      current_path: "/work",
      ext: "txt",
      name: "timetravel-source",
      switch_over: true,
    });
    expect(mockOpenFile).toHaveBeenCalledWith({
      foreground: true,
      path: "/work/.timetravel-source.txt.time-travel",
    });
    expect(result).toMatchObject({
      action_id: "file.timetravel.open",
      path: "/work/.timetravel-source.txt.time-travel",
      source_path: "/work/timetravel-source.txt",
    });
  });

  it("opens the agents tab for Codex", async () => {
    const result = await revealDocsAction({
      actionId: "project.codex.open",
      projectId: "project-1",
    });

    expect(mockSetProjectActiveTab).toHaveBeenCalledWith("agents", {
      change_history: true,
    });
    expect(mockSetFlyoutExpanded).toHaveBeenCalledWith("agents", true);
    expect(result).toMatchObject({
      action_id: "project.codex.open",
      opened: true,
      tab: "agents",
    });
  });
});
