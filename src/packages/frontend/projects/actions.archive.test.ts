import { Map as ImmutableMap } from "immutable";
import { redux as appRedux } from "@cocalc/frontend/app-framework";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getBackups } from "@cocalc/frontend/project/archive-info";
import { alert_message } from "@cocalc/frontend/alerts";

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

jest.mock("@cocalc/frontend/alerts", () => ({
  alert_message: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    is_signed_in: jest.fn(() => true),
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
    project_collaborators: {
      remove: jest.fn(async () => undefined),
    },
  },
}));

const mockedStore = store as jest.Mocked<typeof store>;
const mockedWebappClient = webapp_client as jest.Mocked<typeof webapp_client>;
const getBackupsMock = getBackups as jest.MockedFunction<typeof getBackups>;
const alertMessageMock = alert_message as jest.MockedFunction<
  typeof alert_message
>;

describe("ProjectsActions archive flow", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  function configureProject({
    state,
    lastEdited,
    lastBackup,
    hostId,
    hostInfo,
  }: {
    state: string;
    lastEdited?: Date;
    lastBackup?: Date;
    hostId?: string;
    hostInfo?: Record<string, unknown>;
  }) {
    const hostInfoMap =
      hostId != null && hostInfo != null
        ? ImmutableMap([[hostId, ImmutableMap(hostInfo)]])
        : undefined;
    const projectMap = ImmutableMap([
      [
        project_id,
        ImmutableMap({
          host_id: hostId,
          state: ImmutableMap({ state }),
          last_edited: lastEdited,
          last_backup: lastBackup,
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) => {
      if (key === "project_map") {
        return projectMap;
      }
      if (key === "host_info") {
        return hostInfoMap;
      }
      return undefined;
    });
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
    const async_log = jest.fn(async () => undefined);
    const projectActions = {
      async_log,
      log,
      setState,
      clearFilesystemClient,
      close_all_files,
      set_active_tab,
      trackBackupOp,
      trackStartOp,
    };
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return {};
      }),
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
      async_log,
      log,
      setState,
      clearFilesystemClient,
      close_all_files,
      set_active_tab,
      trackBackupOp,
      trackStartOp,
      redux,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedWebappClient.async_query.mockResolvedValue({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            state_summary: { state: "archived" },
            users_summary: {},
          },
        ],
      },
    } as any);
    mockedWebappClient.project_collaborators.remove.mockResolvedValue(
      undefined as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function projectedState(state: string) {
    return {
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            state_summary: { state },
          },
        ],
      },
    } as any;
  }

  function projectedStateWithTime(state: string, time: string) {
    return {
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            state_summary: { state, time },
            updated_at: time,
          },
        ],
      },
    } as any;
  }

  it("still removes a collaborator when best-effort project logging races with project close", async () => {
    const { actions, async_log } = makeActions();
    async_log.mockRejectedValueOnce(new Error("project closed"));
    jest.spyOn(appRedux, "getStore").mockImplementation((name: string) => {
      if (name === "users") {
        return { get_name: () => "Bella Boo" } as any;
      }
      return {} as any;
    });
    mockedWebappClient.async_query.mockResolvedValueOnce({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            users_summary: {},
          },
        ],
      },
    } as any);

    await actions.remove_collaborator(project_id, "account-1");

    expect(async_log).toHaveBeenCalledWith({
      event: "remove_collaborator",
      removed_name: "Bella Boo",
    });
    expect(
      mockedWebappClient.project_collaborators.remove,
    ).toHaveBeenCalledWith({
      project_id,
      account_id: "account-1",
    });
    expect(alertMessageMock).not.toHaveBeenCalled();
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
    mockedWebappClient.async_query
      .mockResolvedValueOnce(projectedState("opened"))
      .mockResolvedValue(projectedState("archived"));
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
    expect(mockedWebappClient.async_query).toHaveBeenCalledWith({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            state_summary: null,
            updated_at: null,
          },
        ],
      },
      options: [{ limit: 1 }],
    });
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

  it("repairs a dropped projected stop update before resolving stop", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      let projectedStateValue = "running";
      mockedWebappClient.async_query.mockImplementation(async () =>
        projectedState(projectedStateValue),
      );
      const { actions, setState } = makeActions();
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      const repair = jest
        .spyOn(actions, "repairProjectProjection")
        .mockImplementation(async (request) => {
          expect(request).toEqual({
            kind: "project-ids",
            project_ids: [project_id],
            reason: "project-stop",
          });
          projectedStateValue = "opened";
        });

      const stopped = actions.stop_project(project_id);
      await Promise.resolve();

      expect(
        mockedWebappClient.conat_client.hub.projects.stop,
      ).toHaveBeenCalledWith({ project_id });
      expect(repair).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5_000);
      await expect(stopped).resolves.toBe(true);

      expect(repair).toHaveBeenCalledTimes(1);
      expect(setState).toHaveBeenCalledWith({ control_error: "" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("treats a fresh running projection as a converged stop during fast restart", async () => {
    configureProject({
      state: "running",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      hostId: "host-1",
    });
    mockedWebappClient.server_time.mockReturnValue(
      new Date("2026-04-25T16:00:00.000Z"),
    );
    mockedWebappClient.async_query.mockResolvedValue(
      projectedStateWithTime("running", "2026-04-25T16:00:01.000Z"),
    );
    const { actions, setState } = makeActions();
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    await expect(actions.stop_project(project_id)).resolves.toBe(true);

    expect(
      mockedWebappClient.conat_client.hub.projects.stop,
    ).toHaveBeenCalledWith({ project_id });
    expect(setState).toHaveBeenCalledWith({ control_error: "" });
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

  it("waits for the projected archived state after archive RPC succeeds", async () => {
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
    mockedWebappClient.async_query
      .mockResolvedValueOnce({
        query: {
          account_project_index: [
            {
              account_id: "acct-1",
              project_id,
              state_summary: { state: "opened" },
            },
          ],
        },
      } as any)
      .mockResolvedValue({
        query: {
          account_project_index: [
            {
              account_id: "acct-1",
              project_id,
              state_summary: { state: "archived" },
            },
          ],
        },
      } as any);
    const { actions } = makeActions();

    await actions.archive_project(project_id);

    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).toHaveBeenCalledWith({
      project_id,
      timeout: 30000,
    });
    expect(mockedWebappClient.async_query).toHaveBeenCalledWith({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id,
            state_summary: null,
          },
        ],
      },
      options: [{ limit: 1 }],
    });
  });

  it("archives a deprovisioned host without creating another backup", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      lastBackup: new Date("2026-04-25T15:00:00.000Z"),
      hostId: "host-1",
      hostInfo: { status: "deprovisioned", online: false },
    });
    const { actions, setState, trackBackupOp } = makeActions();
    jest
      .spyOn(actions, "ensure_host_info" as any)
      .mockResolvedValue(undefined as any);

    await actions.archive_project(project_id);

    expect(getBackupsMock).not.toHaveBeenCalledWith({
      project_id,
      indexed_only: true,
    });
    expect(
      mockedWebappClient.conat_client.hub.projects.createBackup,
    ).not.toHaveBeenCalled();
    expect(mockedWebappClient.conat_client.lroWait).not.toHaveBeenCalled();
    expect(trackBackupOp).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledWith({
      control_status: "Archiving project from deprovisioned host...",
    });
    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).toHaveBeenCalledWith({
      project_id,
      timeout: 30000,
    });
  });

  it("archives an unavailable host from the latest backup without creating another backup", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      lastBackup: new Date("2026-04-25T15:00:00.000Z"),
      hostId: "host-1",
      hostInfo: { status: "off", online: false },
    });
    const { actions, setState } = makeActions();
    jest
      .spyOn(actions, "ensure_host_info" as any)
      .mockResolvedValue(undefined as any);

    await actions.archive_project(project_id);

    expect(getBackupsMock).not.toHaveBeenCalledWith({
      project_id,
      indexed_only: true,
    });
    expect(
      mockedWebappClient.conat_client.hub.projects.createBackup,
    ).not.toHaveBeenCalled();
    expect(alertMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("cannot create a final backup"),
      }),
    );
    expect(setState).toHaveBeenCalledWith({
      control_status: "Archiving project using the latest available backup...",
    });
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
    mockedWebappClient.async_query.mockResolvedValue(
      projectedState("starting"),
    );

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
    expect(
      mockedWebappClient.project_client.touch_project,
    ).not.toHaveBeenCalled();
    expect(trackStartOp).toHaveBeenCalledWith(
      expect.objectContaining({ op_id: "start-op-1" }),
    );
    expect(setState).toHaveBeenCalledWith({ control_error: "" });
  });

  it("optimistically marks a started project as starting and schedules targeted reconciliation", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, redux } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      const reconcile = jest
        .spyOn(actions as any, "loadProjectedProjectForCurrentAccount")
        .mockResolvedValue(undefined);
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("starting"),
      );

      const started = await actions.start_project(project_id);

      expect(started).toBe(true);
      expect(mockedWebappClient.async_query).not.toHaveBeenCalled();
      expect(
        redux._set_state.mock.calls.some(
          ([state]) =>
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "state",
            ]) === "starting",
        ),
      ).toBe(true);
      expect(reconcile).not.toHaveBeenCalled();

      configureProject({
        state: "starting",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });

      await jest.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledWith(project_id, "project-start");

      await jest.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("logs project_started only after the project is observed running", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      const projectLog = jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      const started = await actions.start_project(project_id);

      expect(started).toBe(true);
      expect(projectLog).toHaveBeenCalledWith(project_id, {
        event: "project_start_requested",
      });
      expect(
        projectLog.mock.calls.some(
          ([, entry]) => entry.event === "project_started",
        ),
      ).toBe(false);

      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(projectLog).toHaveBeenCalledWith(
        project_id,
        expect.objectContaining({
          event: "project_started",
          op_id: "start-op-1",
          duration_ms: expect.any(Number),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
