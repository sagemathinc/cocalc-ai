import { Map as ImmutableMap } from "immutable";
import { redux as appRedux } from "@cocalc/frontend/app-framework";
import { allow_project_to_run } from "@cocalc/frontend/project/client-side-throttle";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getBackups } from "@cocalc/frontend/project/archive-info";

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
    classify_project: jest.fn(() => ({ kind: "member", upgraded: false })),
  },
}));

jest.mock("@cocalc/frontend/project/archive-info", () => ({
  getBackups: jest.fn(),
}));

jest.mock("@cocalc/frontend/project/client-side-throttle", () => ({
  allow_project_to_run: jest.fn(async () => true),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    server_time: jest.fn(() => new Date("2026-04-25T16:00:00.000Z")),
    project_client: {
      touch_project: jest.fn(async () => undefined),
    },
    conat_client: {
      releaseProjectHostRouting: jest.fn(),
      refreshProjectHostRouting: jest.fn(),
      hub: {
        projects: {
          stop: jest.fn(async () => undefined),
          start: jest.fn(async () => ({
            op_id: "start-op-1",
            scope_type: "project",
            scope_id: "project-1",
          })),
          createBackup: jest.fn(async () => ({
            op_id: "backup-op-1",
            scope_type: "project",
            scope_id: "project-1",
            service: "persist-service",
            stream_name: "stream-1",
          })),
          archiveProject: jest.fn(async () => undefined),
        },
      },
      lroWait: jest.fn(async () => ({
        status: "succeeded",
      })),
      projectApi: jest.fn(() => ({
        system: {
          updateSshKeys: jest.fn(async () => undefined),
        },
      })),
    },
    async_query: jest.fn(async () => undefined),
  },
}));

const mockedStore = store as jest.Mocked<typeof store>;
const mockedWebappClient = webapp_client as jest.Mocked<typeof webapp_client>;
const getBackupsMock = getBackups as jest.MockedFunction<typeof getBackups>;
const allowProjectToRunMock = allow_project_to_run as jest.MockedFunction<
  typeof allow_project_to_run
>;

describe("ProjectsActions archive flow", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  function configureProject({
    state,
    lastEdited,
    hostId,
  }: {
    state: string;
    lastEdited?: Date;
    hostId?: string;
  }) {
    const projectMap = ImmutableMap([
      [
        project_id,
        ImmutableMap({
          host_id: hostId,
          state: ImmutableMap({ state }),
          last_edited: lastEdited,
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMap : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    mockedStore.get_state.mockImplementation((id) =>
      id === project_id ? state : undefined,
    );
  }

  function makeActions() {
    const log = jest.fn(async () => undefined);
    const setState = jest.fn();
    const clearFilesystemClient = jest.fn();
    const close_all_files = jest.fn();
    const set_active_tab = jest.fn();
    const trackBackupOp = jest.fn();
    const trackStartOp = jest.fn();
    const projectActions = {
      log,
      setState,
      clearFilesystemClient,
      close_all_files,
      set_active_tab,
      trackBackupOp,
      trackStartOp,
    };
    const redux = {
      getStore: jest.fn(() => ({})),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(() => projectActions),
    } as any;
    jest
      .spyOn(appRedux, "getProjectActions")
      .mockReturnValue(projectActions as any);
    const actions = new ProjectsActions("projects", redux);
    return {
      actions,
      log,
      setState,
      clearFilesystemClient,
      close_all_files,
      set_active_tab,
      trackBackupOp,
      trackStartOp,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    allowProjectToRunMock.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops, creates a final backup, waits, then archives when the latest backup is stale", async () => {
    configureProject({
      state: "running",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      hostId: "host-1",
    });
    getBackupsMock.mockResolvedValue([
      {
        id: "backup-1",
        time: new Date("2026-04-25T15:40:00.000Z"),
        summary: {},
      },
    ] as any);
    const {
      actions,
      setState,
      clearFilesystemClient,
      close_all_files,
      set_active_tab,
      trackBackupOp,
    } = makeActions();
    const ensureHostInfo = jest
      .spyOn(actions, "ensure_host_info" as any)
      .mockResolvedValue(undefined as any);

    await actions.archive_project(project_id);

    expect(
      mockedWebappClient.conat_client.hub.projects.stop,
    ).toHaveBeenCalledWith({ project_id });
    expect(
      mockedWebappClient.conat_client.hub.projects.createBackup,
    ).toHaveBeenCalledWith({ project_id });
    expect(trackBackupOp).toHaveBeenCalledWith(
      expect.objectContaining({ op_id: "backup-op-1" }),
    );
    expect(mockedWebappClient.conat_client.lroWait).toHaveBeenCalledWith({
      op_id: "backup-op-1",
      scope_type: "project",
      scope_id: "project-1",
    });
    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).toHaveBeenCalledWith({
      project_id,
      timeout: 30000,
    });
    expect(setState).toHaveBeenCalledWith({
      control_status: "Stopping project before final backup...",
    });
    expect(setState).toHaveBeenCalledWith({
      control_status: "Creating final backup before archive...",
    });
    expect(setState).toHaveBeenCalledWith({
      control_status: "Archiving project...",
    });
    expect(setState).toHaveBeenLastCalledWith({
      control_error: "",
      control_status: "",
    });
    expect(clearFilesystemClient).toHaveBeenCalled();
    expect(close_all_files).toHaveBeenCalled();
    expect(set_active_tab).toHaveBeenCalledWith("settings", {
      change_history: false,
    });
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({ project_id });
    expect(
      mockedWebappClient.conat_client.refreshProjectHostRouting,
    ).toHaveBeenCalledWith({
      source_host_id: "host-1",
      dest_host_id: "host-1",
    });
    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
  });

  it("reuses a fresh backup and skips the extra backup LRO", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:00:00.000Z"),
    });
    getBackupsMock.mockResolvedValue([
      {
        id: "backup-1",
        time: new Date("2026-04-25T15:10:00.000Z"),
        summary: {},
      },
    ] as any);
    const { actions, setState, trackBackupOp } = makeActions();

    await actions.archive_project(project_id);

    expect(
      mockedWebappClient.conat_client.hub.projects.stop,
    ).not.toHaveBeenCalled();
    expect(
      mockedWebappClient.conat_client.hub.projects.createBackup,
    ).not.toHaveBeenCalled();
    expect(mockedWebappClient.conat_client.lroWait).not.toHaveBeenCalled();
    expect(trackBackupOp).not.toHaveBeenCalled();
    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).toHaveBeenCalledWith({
      project_id,
      timeout: 30000,
    });
    expect(setState).toHaveBeenCalledWith({
      control_status: "Archiving project...",
    });
  });

  it("does not archive if the final backup LRO fails", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
    });
    getBackupsMock.mockResolvedValue([]);
    mockedWebappClient.conat_client.lroWait.mockResolvedValueOnce({
      status: "failed",
      error: "backup failed",
    } as any);
    const { actions, setState } = makeActions();

    await expect(actions.archive_project(project_id)).rejects.toThrow(
      "backup failed",
    );

    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith({
      control_status: "",
      control_error: "Error archiving project -- Error: backup failed",
    });
  });

  it("resets project runtime state before starting an archived project", async () => {
    configureProject({
      state: "archived",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      hostId: "host-1",
    });
    const { actions, trackStartOp, setState } = makeActions();
    const ensureHostInfo = jest
      .spyOn(actions, "ensure_host_info" as any)
      .mockResolvedValue(undefined as any);
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    const started = await actions.start_project(project_id);

    expect(started).toBe(true);
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({ project_id });
    expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
    expect(
      mockedWebappClient.conat_client.hub.projects.start,
    ).toHaveBeenCalledWith({
      project_id,
      wait: false,
    });
    expect(trackStartOp).toHaveBeenCalledWith(
      expect.objectContaining({ op_id: "start-op-1" }),
    );
    expect(setState).toHaveBeenCalledWith({ control_error: "" });
  });
});
