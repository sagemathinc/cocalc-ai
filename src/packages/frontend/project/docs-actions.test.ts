/** @jest-environment jsdom */

const mockSetPageActiveTab = jest.fn();
const mockSetProjectActiveTab = jest.fn();
const mockSetFlyoutExpanded = jest.fn();
const mockCreateFile = jest.fn();
const mockConstructAbsolutePath = jest.fn();
const mockGetStore = jest.fn();
const mockGetProjectActions = jest.fn();

jest.mock("@cocalc/frontend/account/default-file-name-generator", () => ({
  default_filename: (ext: string) => `Untitled.${ext}`,
}));

jest.mock("@cocalc/frontend/app-framework", () => ({
  redux: {
    getActions: (name: string) =>
      name === "page"
        ? {
            set_active_tab: mockSetPageActiveTab,
          }
        : undefined,
    getProjectActions: (projectId: string) => mockGetProjectActions(projectId),
  },
}));

import {
  RUNTIME_IMAGE_DOCS_ACTION_EVENT,
  listDocsAppActions,
  revealDocsAction,
} from "./docs-actions";

describe("project docs actions", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    window.localStorage.clear();
    mockGetStore.mockReturnValue({
      get: (key: string) => (key === "current_path_abs" ? "/work" : undefined),
    });
    mockConstructAbsolutePath.mockImplementation(
      (name: string, currentPath: string, ext: string) =>
        `${currentPath}/${name}.${ext}`,
    );
    mockGetProjectActions.mockReturnValue({
      construct_absolute_path: mockConstructAbsolutePath,
      createFile: mockCreateFile,
      get_store: mockGetStore,
      set_active_tab: mockSetProjectActiveTab,
      setFlyoutExpanded: mockSetFlyoutExpanded,
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("reports terminal, notebook, rootfs, and secrets as implemented", () => {
    const actions = listDocsAppActions({ projectId: "project-1" });
    expect(
      actions.filter((action) => action.implemented).map((action) => action.id),
    ).toEqual(
      expect.arrayContaining([
        "settings.environment.secrets",
        "project.terminal.open",
        "project.jupyter.create",
        "settings.runtime.rootfs",
      ]),
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
      name: "Untitled",
      switch_over: true,
    });
    expect(result).toMatchObject({
      action_id: "project.terminal.open",
      opened: true,
      path: "/work/Untitled.term",
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
      name: "Untitled",
      switch_over: true,
    });
  });

  it("opens the runtime image modal in project settings", async () => {
    const events: string[] = [];
    window.addEventListener(RUNTIME_IMAGE_DOCS_ACTION_EVENT, () =>
      events.push("runtime-image"),
    );

    const result = await revealDocsAction({
      actionId: "settings.runtime.rootfs",
      projectId: "project-1",
    });

    expect(events).toEqual(["runtime-image"]);
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
});
