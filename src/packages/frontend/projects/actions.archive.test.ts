import { Map as ImmutableMap } from "immutable";
import { redux as appRedux } from "@cocalc/frontend/app-framework";

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

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    server_time: jest.fn(() => new Date("2026-04-25T16:00:00.000Z")),
    conat_client: {
      hub: {
        projects: {
          stop: jest.fn(async () => undefined),
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

describe("ProjectsActions archive flow", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  function configureProject({
    state,
    lastEdited,
  }: {
    state: string;
    lastEdited?: Date;
  }) {
    const projectMap = ImmutableMap([
      [
        project_id,
        ImmutableMap({
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
    const trackBackupOp = jest.fn();
    const projectActions = {
      log,
      setState,
      clearFilesystemClient,
      trackBackupOp,
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
      trackBackupOp,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("stops, creates a final backup, waits, then archives when the latest backup is stale", async () => {
    configureProject({
      state: "running",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
    });
    getBackupsMock.mockResolvedValue([
      {
        id: "backup-1",
        time: new Date("2026-04-25T15:40:00.000Z"),
        summary: {},
      },
    ] as any);
    const { actions, setState, clearFilesystemClient, trackBackupOp } =
      makeActions();

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
    expect(setState).toHaveBeenCalledWith({ control_error: "" });
    expect(clearFilesystemClient).toHaveBeenCalled();
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
    const { actions, trackBackupOp } = makeActions();

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
      control_error: "Error archiving project -- Error: backup failed",
    });
  });
});
