import { Map as ImmutableMap } from "immutable";
import { redux as appRedux } from "@cocalc/frontend/app-framework";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { getBackups } from "@cocalc/frontend/project/archive-info";
import { alert_message } from "@cocalc/frontend/alerts";
import { selectHostForProjectStart } from "@cocalc/frontend/hosts/select-host-for-project-start";

const mockRecordUxLatencyEvent = jest.fn();

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

jest.mock("@cocalc/frontend/hosts/select-host-for-project-start", () => ({
  selectHostForProjectStart: jest.fn(),
}));

jest.mock("@cocalc/frontend/monitoring/ux-latency", () => ({
  startUxTimer: jest.fn(() => Date.now()),
  elapsedUxMs: jest.fn((start: number) => Date.now() - start),
  recordUxLatencyEvent: (...args: any[]) => mockRecordUxLatencyEvent(...args),
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
          getProjectState: jest.fn(async () => undefined),
          restart: jest.fn(async () => ({
            op_id: "restart-op-1",
            scope_type: "project",
            scope_id: "project-1",
          })),
          assignProjectHost: jest.fn(async () => undefined),
          createBackup: jest.fn(async () => ({
            op_id: "backup-op-1",
            scope_type: "project",
            scope_id: "project-1",
            service: "persist-service",
            stream_name: "stream-1",
          })),
          archiveProject: jest.fn(async () => undefined),
        },
        hosts: {
          listHosts: jest.fn(async () => []),
        },
        lro: {
          get: jest.fn(async () => undefined),
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
const selectHostForProjectStartMock =
  selectHostForProjectStart as jest.MockedFunction<
    typeof selectHostForProjectStart
  >;

describe("ProjectsActions archive flow", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";
  let configuredProjectMap = ImmutableMap();

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
    configuredProjectMap = ImmutableMap([
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
        return configuredProjectMap;
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
      return configuredProjectMap.getIn(path.slice(1) as any);
    });
    mockedStore.get_state.mockImplementation((id) =>
      id === project_id ? state : undefined,
    );
  }

  function makeActions({ mutableProjectStore = false } = {}) {
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
        if (name === "customize") {
          return ImmutableMap({
            country: "US",
            cloudflare_region_code: "CA",
          });
        }
        return {};
      }),
      _set_state: jest.fn((state) => {
        const nextProjectMap = state.projects?.project_map;
        if (mutableProjectStore && nextProjectMap != null) {
          configuredProjectMap = nextProjectMap;
        }
      }),
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
    mockRecordUxLatencyEvent.mockClear();
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
    mockedWebappClient.conat_client.hub.hosts.listHosts.mockResolvedValue(
      [] as any,
    );
    mockedWebappClient.conat_client.hub.lro.get.mockResolvedValue(
      undefined as any,
    );
    mockedWebappClient.conat_client.lroWait.mockResolvedValue({
      status: "succeeded",
      result: { phase_timings_ms: { cache_rootfs: 20 } },
    } as any);
    mockedWebappClient.conat_client.hub.projects.getProjectState.mockResolvedValue(
      undefined as any,
    );
    selectHostForProjectStartMock.mockResolvedValue(undefined);
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

  it("uses durable backup metadata when repository browsing is unavailable", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:00:00.000Z"),
      lastBackup: new Date("2026-04-25T15:10:00.000Z"),
    });
    getBackupsMock.mockRejectedValue(new Error("repository browser offline"));
    const { actions } = makeActions();

    await actions.archive_project(project_id);

    expect(
      mockedWebappClient.conat_client.hub.projects.createBackup,
    ).not.toHaveBeenCalled();
    expect(
      mockedWebappClient.conat_client.hub.projects.archiveProject,
    ).toHaveBeenCalledWith({
      project_id,
      timeout: 30000,
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

  it("auto-assigns an unplaced project to an available same-region host before starting", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
    });
    mockedWebappClient.conat_client.hub.hosts.listHosts.mockResolvedValue([
      {
        id: "host-west",
        name: "West host",
        owner: "acct-1",
        region: "us-west1",
        size: "small",
        gpu: false,
        status: "running",
        can_place: true,
      },
    ] as any);
    const { actions } = makeActions();
    const assign = jest
      .spyOn(actions, "assign_project_to_host")
      .mockResolvedValue(true);
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    const started = await actions.start_project(project_id);

    expect(started).toBe(true);
    expect(assign).toHaveBeenCalledWith(project_id, "host-west");
    expect(selectHostForProjectStartMock).not.toHaveBeenCalled();
    expect(
      mockedWebappClient.conat_client.hub.projects.start,
    ).toHaveBeenCalledWith({
      project_id,
      wait: false,
    });
  });

  it("prompts for a remote host when an unplaced project has no same-region hosts", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
    });
    mockedWebappClient.conat_client.hub.hosts.listHosts.mockResolvedValue([
      {
        id: "host-europe",
        name: "Europe host",
        owner: "acct-1",
        region: "europe-west1",
        size: "small",
        gpu: false,
        status: "running",
        can_place: true,
      },
    ] as any);
    selectHostForProjectStartMock.mockResolvedValue({
      host_id: "host-europe",
    });
    const { actions } = makeActions();
    const assign = jest
      .spyOn(actions, "assign_project_to_host")
      .mockResolvedValue(true);
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    const started = await actions.start_project(project_id);

    expect(started).toBe(true);
    expect(selectHostForProjectStartMock).toHaveBeenCalledWith({
      projectRegion: "wnam",
    });
    expect(assign).toHaveBeenCalledWith(project_id, "host-europe");
    expect(
      mockedWebappClient.conat_client.hub.projects.start,
    ).toHaveBeenCalledWith({
      project_id,
      wait: false,
    });
  });

  it("assigns a selected remote host before restoring an archived unplaced project", async () => {
    configureProject({
      state: "archived",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
    });
    mockedWebappClient.conat_client.hub.hosts.listHosts.mockResolvedValue([
      {
        id: "host-europe",
        name: "Europe host",
        owner: "acct-1",
        region: "europe-west1",
        size: "small",
        gpu: false,
        status: "running",
        can_place: true,
      },
    ] as any);
    selectHostForProjectStartMock.mockResolvedValue({
      host_id: "host-europe",
    });
    const { actions } = makeActions();
    const assign = jest
      .spyOn(actions, "assign_project_to_host")
      .mockResolvedValue(true);
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    const started = await actions.start_project(project_id);

    expect(started).toBe(true);
    expect(assign).toHaveBeenCalledWith(project_id, "host-europe");
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({ project_id });
    expect(assign.mock.invocationCallOrder[0]).toBeLessThan(
      mockedWebappClient.conat_client.releaseProjectHostRouting.mock
        .invocationCallOrder[0],
    );
  });

  it("converges from a successful start LRO and retains projection fallbacks", async () => {
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
      await Promise.resolve();

      expect(started).toBe(true);
      expect(mockedWebappClient.conat_client.lroWait).toHaveBeenCalledWith(
        expect.objectContaining({ op_id: "start-op-1" }),
      );
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
      expect(
        redux._set_state.mock.calls.some(
          ([state]) =>
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "state",
            ]) === "running" &&
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "source",
            ]) === "project-start-lro",
        ),
      ).toBe(true);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledWith(project_id, "project-start");

      configureProject({
        state: "starting",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });

      await jest.advanceTimersByTimeAsync(1_000);
      expect(reconcile).toHaveBeenCalledWith(project_id, "project-start");
      expect(reconcile).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(5_000);
      expect(reconcile).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("converges directly when start returns a terminal acknowledgement", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.hub.projects.start.mockResolvedValueOnce({
        op_id: "start-op-foreground",
        scope_type: "project",
        scope_id: project_id,
        service: "persist-service",
        stream_name: "stream:start-op-foreground",
        terminal_status: "succeeded",
      });
      const { actions, redux } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      jest
        .spyOn(actions as any, "loadProjectedProjectForCurrentAccount")
        .mockResolvedValue(undefined);

      const started = await actions.start_project(project_id);
      await Promise.resolve();

      expect(started).toBe(true);
      expect(
        mockedWebappClient.conat_client.hub.projects.start,
      ).toHaveBeenCalledWith({ project_id, wait: false });
      expect(mockedWebappClient.conat_client.lroWait).not.toHaveBeenCalled();
      expect(
        redux._set_state.mock.calls.some(
          ([state]) =>
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "state",
            ]) === "running" &&
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "source",
            ]) === "project-start-lro",
        ),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("marks restart requests locally so fast restarts still reset runtime consumers", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, redux, setState, trackStartOp } = makeActions();
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("running"),
      );

      await actions.restart_project(project_id);

      expect(
        mockedWebappClient.conat_client.hub.projects.restart,
      ).toHaveBeenCalledWith({
        project_id,
        restart_request_id: expect.any(String),
        wait: false,
      });
      expect(trackStartOp).toHaveBeenCalledWith(
        expect.objectContaining({ op_id: "restart-op-1" }),
      );
      expect(setState).toHaveBeenCalledWith({
        restart_request: expect.objectContaining({
          get: expect.any(Function),
        }),
      });
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

      jest.advanceTimersByTime(8_000);
      expect(setState).toHaveBeenCalledWith({ restart_request: undefined });
    } finally {
      jest.useRealTimers();
    }
  });

  it("submits a distinct restart intent while an earlier restart is pending", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, setState, trackStartOp } = makeActions({
        mutableProjectStore: true,
      });
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("running"),
      );

      let resolveFirstRestart!: (value: any) => void;
      const firstRestartStarted = new Promise<void>((resolve) => {
        mockedWebappClient.conat_client.hub.projects.restart
          .mockImplementationOnce(
            () =>
              new Promise((resolveRestart) => {
                resolveFirstRestart = resolveRestart;
                resolve();
              }),
          )
          .mockResolvedValueOnce({
            op_id: "restart-op-2",
            scope_type: "project",
            scope_id: project_id,
          } as any);
      });

      const first = actions.restart_project(project_id);
      await firstRestartStarted;
      const second = actions.restart_project(project_id);
      await second;

      expect(
        mockedWebappClient.conat_client.hub.projects.restart,
      ).toHaveBeenCalledTimes(2);
      const firstRequest =
        mockedWebappClient.conat_client.hub.projects.restart.mock.calls[0][0];
      const secondRequest =
        mockedWebappClient.conat_client.hub.projects.restart.mock.calls[1][0];
      expect(firstRequest.restart_request_id).toEqual(expect.any(String));
      expect(secondRequest.restart_request_id).toEqual(expect.any(String));
      expect(secondRequest.restart_request_id).not.toBe(
        firstRequest.restart_request_id,
      );

      resolveFirstRestart({
        op_id: "restart-op-1",
        scope_type: "project",
        scope_id: project_id,
      });
      await first;

      expect(trackStartOp).toHaveBeenCalledTimes(1);
      expect(trackStartOp).toHaveBeenCalledWith(
        expect.objectContaining({ op_id: "restart-op-2" }),
      );
      const visibleRestartRequests = setState.mock.calls
        .map(([state]) => state.restart_request)
        .filter((request) => request?.get != null);
      expect(visibleRestartRequests.at(-1)?.get("token")).toBe(
        secondRequest.restart_request_id,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not let an older restart success hide the latest failure", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, setState, trackStartOp } = makeActions({
        mutableProjectStore: true,
      });
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("running"),
      );

      let resolveFirstRestart!: (value: any) => void;
      const firstRestartStarted = new Promise<void>((resolve) => {
        mockedWebappClient.conat_client.hub.projects.restart
          .mockImplementationOnce(
            () =>
              new Promise((resolveRestart) => {
                resolveFirstRestart = resolveRestart;
                resolve();
              }),
          )
          .mockRejectedValueOnce(new Error("latest restart failed"));
      });

      const first = actions.restart_project(project_id);
      await firstRestartStarted;
      await expect(actions.restart_project(project_id)).rejects.toThrow(
        "latest restart failed",
      );

      resolveFirstRestart({
        op_id: "restart-op-1",
        scope_type: "project",
        scope_id: project_id,
      });
      await first;

      expect(trackStartOp).not.toHaveBeenCalled();
      expect(setState).toHaveBeenCalledWith({
        control_error:
          "Error restarting project -- Error: latest restart failed",
      });
      expect(setState).not.toHaveBeenCalledWith({ control_error: "" });
      expect(
        mockedStore.getIn(["project_map", project_id, "state", "state"]),
      ).toBe("running");
    } finally {
      jest.useRealTimers();
    }
  });

  it("restores the pre-overlap state when both restarts fail", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, trackStartOp } = makeActions({
        mutableProjectStore: true,
      });
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("running"),
      );

      let rejectFirstRestart!: (reason: Error) => void;
      const firstRestartStarted = new Promise<void>((resolve) => {
        mockedWebappClient.conat_client.hub.projects.restart
          .mockImplementationOnce(
            () =>
              new Promise((_resolveRestart, rejectRestart) => {
                rejectFirstRestart = rejectRestart;
                resolve();
              }),
          )
          .mockRejectedValueOnce(new Error("latest restart failed"));
      });

      const first = actions.restart_project(project_id);
      await firstRestartStarted;
      expect(
        mockedStore.getIn(["project_map", project_id, "state", "state"]),
      ).toBe("starting");

      await expect(actions.restart_project(project_id)).rejects.toThrow(
        "latest restart failed",
      );
      rejectFirstRestart(new Error("older restart failed"));
      await expect(first).rejects.toThrow("older restart failed");

      expect(trackStartOp).not.toHaveBeenCalled();
      expect(
        mockedStore.getIn(["project_map", project_id, "state", "state"]),
      ).toBe("running");
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not let an older restart failure replace the latest success", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      const { actions, setState, trackStartOp } = makeActions();
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});
      mockedWebappClient.async_query.mockResolvedValue(
        projectedState("running"),
      );

      let rejectFirstRestart!: (reason: Error) => void;
      const firstRestartStarted = new Promise<void>((resolve) => {
        mockedWebappClient.conat_client.hub.projects.restart
          .mockImplementationOnce(
            () =>
              new Promise((_resolveRestart, rejectRestart) => {
                rejectFirstRestart = rejectRestart;
                resolve();
              }),
          )
          .mockResolvedValueOnce({
            op_id: "restart-op-2",
            scope_type: "project",
            scope_id: project_id,
          } as any);
      });

      const first = actions.restart_project(project_id);
      await firstRestartStarted;
      await actions.restart_project(project_id);

      rejectFirstRestart(new Error("older restart failed"));
      await expect(first).rejects.toThrow("older restart failed");

      expect(trackStartOp).toHaveBeenCalledTimes(1);
      expect(trackStartOp).toHaveBeenCalledWith(
        expect.objectContaining({ op_id: "restart-op-2" }),
      );
      expect(setState).not.toHaveBeenCalledWith({
        control_error:
          "Error restarting project -- Error: older restart failed",
      });
      expect(setState).toHaveBeenCalledWith({ control_error: "" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not wait for a normal host-info refresh before starting", async () => {
    configureProject({
      state: "opened",
      lastEdited: new Date("2026-04-25T15:55:00.000Z"),
      hostId: "host-1",
    });
    const { actions } = makeActions();
    const unresolvedHostRefresh = new Promise<never>(() => undefined);
    const ensureHostInfo = jest
      .spyOn(actions, "ensure_host_info" as any)
      .mockReturnValue(unresolvedHostRefresh);
    jest
      .spyOn(actions as any, "project_log")
      .mockImplementation(async () => {});

    await expect(actions.start_project(project_id)).resolves.toBe(true);

    expect(ensureHostInfo).toHaveBeenCalledWith("host-1");
    expect(
      mockedWebappClient.conat_client.hub.projects.start,
    ).toHaveBeenCalledWith({
      project_id,
      wait: false,
    });
  });

  it("retains start intent while an assigned host is recovering", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        hostId: "host-1",
        hostInfo: {
          desired_state: "running",
          online: false,
          reason_unavailable: "Host is starting; it must be running.",
          recovery_phase: "running_standard_fallback",
          status: "starting",
          updated_at: Date.now(),
        },
      });
      const { actions, setState } = makeActions();
      const ensureHostInfo = jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValueOnce(
          ImmutableMap({
            desired_state: "running",
            recovery_phase: "running_standard_fallback",
            status: "running",
          }),
        )
        .mockResolvedValueOnce(
          ImmutableMap({
            desired_state: "running",
            online: true,
            recovery_phase: "running_standard_fallback",
            status: "running",
          }),
        );
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      const started = actions.start_project(project_id);
      await Promise.resolve();
      expect(
        mockedWebappClient.conat_client.hub.projects.start,
      ).not.toHaveBeenCalled();
      expect(setState).toHaveBeenCalledWith({
        control_error: "",
        control_status: "Waiting for the project host to reconnect...",
      });

      await jest.advanceTimersByTimeAsync(10_000);
      expect(
        mockedWebappClient.conat_client.hub.projects.start,
      ).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(started).resolves.toBe(true);

      expect(ensureHostInfo).toHaveBeenCalledWith("host-1", true);
      expect(
        mockedWebappClient.conat_client.hub.projects.start,
      ).toHaveBeenCalledWith({
        project_id,
        wait: false,
      });
      expect(alertMessageMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      );
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

  it("records a successful cache hit as a warm provisioned start", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.lroWait.mockResolvedValueOnce({
        status: "succeeded",
        started_at: new Date(Date.now() - 4_000),
        finished_at: new Date(),
        result: { phase_timings_ms: { cache_rootfs: 21 } },
      } as any);
      const { actions } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_running",
          segment: "warm_provisioned",
          details: expect.objectContaining({
            browser_started_at: expect.any(String),
            start_rpc_returned_at: expect.any(String),
            lro_completed_at: expect.any(String),
            running_observed_at: expect.any(String),
            lro_status: "succeeded",
            rootfs_cache_ms: 21,
          }),
        }),
      );
      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_admission",
          segment: "warm_provisioned",
          started_at: expect.any(String),
        }),
      );
      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_backend_lifecycle",
          duration_ms: 4_000,
          segment: "warm_provisioned",
        }),
      );
      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_frontend_convergence",
          segment: "warm_provisioned",
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("excludes material RootFS preparation from warm startup timing", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.lroWait.mockResolvedValueOnce({
        status: "succeeded",
        result: { phase_timings_ms: { cache_rootfs: 21_430 } },
      } as any);
      const { actions } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_running",
          segment: "rootfs_prepare",
          details: expect.objectContaining({
            lro_status: "succeeded",
            rootfs_cache_ms: 21_430,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("does not count a canceled joined start as warm", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.lroWait.mockResolvedValueOnce({
        status: "canceled",
        error: "superseded by the already-running project start",
      } as any);
      const { actions } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);
      configureProject({
        state: "running",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      await jest.advanceTimersByTimeAsync(1_000);

      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metric: "project_start_running",
          segment: "host_start_or_unknown",
          details: expect.objectContaining({ lro_status: "canceled" }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it("records a browser-observed stuck project start after the stuck threshold", async () => {
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
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);

      await jest.advanceTimersByTimeAsync(59_000);
      expect(mockRecordUxLatencyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ metric: "project_start_running_stuck" }),
      );

      await jest.advanceTimersByTimeAsync(1_000);
      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "project_start",
          metric: "project_start_running_stuck",
          project_id,
          details: expect.objectContaining({
            op_id: "start-op-1",
            stuck_after_ms: 60_000,
          }),
        }),
      );

      const stuckCalls = mockRecordUxLatencyEvent.mock.calls.filter(
        ([event]) => event?.metric === "project_start_running_stuck",
      );
      expect(stuckCalls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("records stale project stream instead of stuck when authoritative project state is running", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.hub.projects.getProjectState.mockResolvedValue(
        { state: "running" } as any,
      );
      const { actions, redux } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "project_start",
          metric: "project_start_running_stream_stale",
          project_id,
          details: expect.objectContaining({
            observed_state: "opened",
            authoritative_state: "running",
            state_source: "authoritative_probe",
          }),
        }),
      );
      expect(mockRecordUxLatencyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ metric: "project_start_running" }),
      );
      expect(mockRecordUxLatencyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ metric: "project_start_running_stuck" }),
      );
      expect(
        mockedWebappClient.conat_client.hub.projects.getProjectState,
      ).toHaveBeenCalledWith({ project_id });
      expect(
        redux._set_state.mock.calls.some(
          ([state]) =>
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "state",
            ]) === "running" &&
            state.projects?.project_map?.getIn?.([
              project_id,
              "state",
              "source",
            ]) === "authoritative-project-state",
        ),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it("records an intentional blocked project start instead of stuck when the start LRO failed", async () => {
    jest.useFakeTimers();
    try {
      configureProject({
        state: "opened",
        lastEdited: new Date("2026-04-25T15:55:00.000Z"),
        hostId: "host-1",
      });
      mockedWebappClient.conat_client.hub.lro.get.mockResolvedValue({
        status: "failed",
        error: "runtime CPU usage limit exceeded",
      } as any);
      const { actions } = makeActions();
      jest
        .spyOn(actions, "ensure_host_info" as any)
        .mockResolvedValue(undefined as any);
      jest
        .spyOn(actions as any, "project_log")
        .mockImplementation(async () => {});

      await expect(actions.start_project(project_id)).resolves.toBe(true);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(mockRecordUxLatencyEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "project_start",
          metric: "project_start_running_blocked",
          project_id,
          details: expect.objectContaining({
            op_id: "start-op-1",
            op_status: "failed",
            op_error: "runtime CPU usage limit exceeded",
          }),
        }),
      );
      expect(mockRecordUxLatencyEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ metric: "project_start_running_stuck" }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
