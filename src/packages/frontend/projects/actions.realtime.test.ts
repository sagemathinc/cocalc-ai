import { EventEmitter } from "events";
import { List, Map as ImmutableMap } from "immutable";

import { redux as appRedux } from "@cocalc/frontend/app-framework";
import { accountFeedStreamName } from "../../conat/hub/api/account-feed";
import { getSharedAccountDStream } from "@cocalc/frontend/conat/account-dstream";

jest.mock("@cocalc/frontend/conat/account-dstream", () => ({
  getSharedAccountDStream: jest.fn(),
}));

const refreshProjectsTableMock = jest.fn(async () => undefined);

jest.mock("./table", () => ({
  refresh_projects_table: refreshProjectsTableMock,
  switch_to_project: jest.fn(),
}));

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
  },
}));

const invalidateProjectFieldsMock = jest.fn();

jest.mock("@cocalc/frontend/project/use-project-field", () => ({
  createProjectFieldState: jest.fn((field: string) => ({
    field,
    cache: new Map(),
    listeners: new Map(),
    refreshers: new Map(),
    inflight: new Map(),
  })),
  ensureProjectFieldValue: jest.fn(),
  getCachedProjectFieldValue: jest.fn(),
  invalidateProjectFields: (...args: any[]) =>
    invalidateProjectFieldsMock(...args),
  useProjectField: jest.fn(() => ({
    value: null,
    refresh: jest.fn(),
    setValue: jest.fn(),
  })),
}));

jest.mock("@cocalc/frontend/project/use-project-course", () => ({
  ensureProjectCourseInfo: jest.fn(async () => null),
}));

jest.mock("@cocalc/frontend/webapp-client", () => {
  const webappClient = Object.assign(new EventEmitter(), {
    is_signed_in: jest.fn(() => true),
    async_query: jest.fn(async () => ({
      query: { account_project_index: [] },
    })),
    conat_client: Object.assign(new EventEmitter(), {
      releaseProjectHostRouting: jest.fn(),
      refreshProjectHostRouting: jest.fn(),
      reconnect: jest.fn(),
    }),
  });

  return { webapp_client: webappClient };
});

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { store } from "./store";
import { ProjectsActions } from "./actions";

const mockedStore = store as jest.Mocked<typeof store>;
const mockedWebappClient = webapp_client as unknown as EventEmitter & {
  is_signed_in: jest.Mock;
  conat_client: EventEmitter;
  async_query: jest.Mock;
};
const getSharedAccountDStreamMock = getSharedAccountDStream as jest.Mock;

class MockFeed extends EventEmitter {
  private closed = false;

  close() {
    this.closed = true;
    this.removeAllListeners();
  }

  isClosed() {
    return this.closed;
  }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectsActions realtime feed", () => {
  let projectMap = ImmutableMap<string, any>();
  let openProjects = List<string>();

  beforeEach(() => {
    jest.clearAllMocks();
    refreshProjectsTableMock.mockResolvedValue(undefined);
    projectMap = ImmutableMap<string, any>();
    openProjects = List<string>();
    mockedWebappClient.is_signed_in.mockReturnValue(true);
    getSharedAccountDStreamMock.mockResolvedValue(new MockFeed());
    mockedStore.get.mockImplementation((key: string) => {
      switch (key) {
        case "project_map":
          return projectMap;
        case "open_projects":
          return openProjects;
        default:
          return undefined;
      }
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("subscribes to the account feed and applies project upserts to project_map", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.now(),
      account_id: "acct-1",
      project: {
        project_id: "project-1",
        title: "Realtime Project",
        description: "from feed",
        name: "realtime-project",
        theme: {
          color: "#ff0000",
          accent_color: null,
          icon: "folder-open",
          image_blob: null,
        },
        host_id: null,
        owning_bay_id: "bay-0",
        users: {
          "acct-1": { group: "owner" },
        },
        state: { state: "running" },
        last_active: { "acct-1": "2026-04-05T03:00:00.000Z" },
        last_edited: "2026-04-05T03:00:00.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(projectMap.getIn(["project-1", "title"])).toBe("Realtime Project");
    expect(projectMap.getIn(["project-1", "state", "state"])).toBe("running");
    expect(projectMap.getIn(["project-1", "theme", "color"])).toBe("#ff0000");
    expect(projectMap.getIn(["project-1", "users", "acct-1", "group"])).toBe(
      "owner",
    );
    expect(projectMap.getIn(["project-1", "last_edited"])).toBeInstanceOf(Date);
  });

  it("batches multiple project upserts into one state update", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();
    redux._set_state.mockClear();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.now(),
      account_id: "acct-1",
      project: {
        project_id: "project-1",
        title: "First",
        description: "",
        name: null,
        theme: null,
        host_id: null,
        owning_bay_id: "bay-0",
        users: {},
        state: { state: "opened" },
        last_active: {},
        last_edited: "2026-04-05T03:00:00.000Z",
        deleted: false,
      },
    });
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.now(),
      account_id: "acct-1",
      project: {
        project_id: "project-2",
        title: "Second",
        description: "",
        name: null,
        theme: null,
        host_id: null,
        owning_bay_id: "bay-0",
        users: {},
        state: { state: "running" },
        last_active: {},
        last_edited: "2026-04-05T03:00:01.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(redux._set_state).toHaveBeenCalledTimes(1);
    expect(projectMap.getIn(["project-1", "title"])).toBe("First");
    expect(projectMap.getIn(["project-2", "state", "state"])).toBe("running");
  });

  it("keeps the newest project upsert within a batch when arrivals are out of order", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.parse("2026-04-05T03:00:02.000Z"),
      account_id: "acct-1",
      project: {
        project_id: "project-1",
        title: "Newest Title",
        description: "",
        name: null,
        theme: null,
        host_id: null,
        owning_bay_id: "bay-0",
        users: {},
        state: {
          state: "running",
          time: "2026-04-05T03:00:02.000Z",
        },
        last_active: {},
        last_edited: "2026-04-05T03:00:02.000Z",
        deleted: false,
      },
    });
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.parse("2026-04-05T03:00:01.000Z"),
      account_id: "acct-1",
      project: {
        project_id: "project-1",
        title: "Older Title",
        description: "",
        name: null,
        theme: null,
        host_id: null,
        owning_bay_id: "bay-0",
        users: {},
        state: {
          state: "opened",
          time: "2026-04-05T03:00:01.000Z",
        },
        last_active: {},
        last_edited: "2026-04-05T03:00:01.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(projectMap.getIn(["project-1", "title"])).toBe("Newest Title");
    expect(projectMap.getIn(["project-1", "state", "state"])).toBe("running");
  });

  it("resets routing for an open project when the feed reports a host change", async () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          host_id: "host-old",
          owning_bay_id: "bay-0",
        }),
      ],
    ]);
    openProjects = List([projectId]);
    mockedStore.get.mockImplementation((key: string) => {
      switch (key) {
        case "project_map":
          return projectMap;
        case "open_projects":
          return openProjects;
        default:
          return undefined;
      }
    });
    const resetProjectHostRuntime = jest.fn();
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
        resetProjectHostRuntime,
      })),
    } as any;
    jest
      .spyOn(appRedux, "getProjectActions")
      .mockReturnValue({ resetProjectHostRuntime } as any);
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.now(),
      account_id: "acct-1",
      project: {
        project_id: projectId,
        title: "Realtime Project",
        description: "from feed",
        name: "realtime-project",
        theme: null,
        host_id: "host-new",
        owning_bay_id: "bay-0",
        users: {
          "acct-1": { group: "owner" },
        },
        state: { state: "running" },
        last_active: { "acct-1": "2026-04-05T03:00:00.000Z" },
        last_edited: "2026-04-05T03:00:00.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(projectMap.getIn([projectId, "host_id"])).toBe("host-new");
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({ project_id: projectId });
    expect(
      mockedWebappClient.conat_client.refreshProjectHostRouting,
    ).toHaveBeenCalledWith({
      source_host_id: "host-old",
      dest_host_id: "host-new",
    });
    expect(resetProjectHostRuntime).toHaveBeenCalled();
    expect(mockedWebappClient.conat_client.reconnect).not.toHaveBeenCalled();
  });

  it("keeps a newer local moved host when realtime upserts are older", async () => {
    const projectId = "00000000-0000-4000-8000-000000000004";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          host_id: "host-new",
          title: "Moved Project",
        }),
      ],
    ]);
    openProjects = List([projectId]);
    const projectStore = ImmutableMap({
      move_lro: ImmutableMap({
        summary: {
          status: "succeeded",
          updated_at: "2026-04-05T03:05:00.000Z",
        },
      }),
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      getProjectStore: jest.fn(() => projectStore),
      _set_state: jest.fn((state) => {
        if (state.projects.project_map != null) {
          projectMap = state.projects.project_map;
        }
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.parse("2026-04-05T03:00:00.000Z"),
      account_id: "acct-1",
      project: {
        project_id: projectId,
        title: "Moved Project",
        description: "stale realtime row",
        name: null,
        theme: null,
        host_id: "host-old",
        owning_bay_id: "bay-0",
        users: {
          "acct-1": { group: "owner" },
        },
        state: { state: "running" },
        last_active: { "acct-1": "2026-04-05T03:00:00.000Z" },
        last_edited: "2026-04-05T03:00:00.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(projectMap.getIn([projectId, "host_id"])).toBe("host-new");
    expect(projectMap.getIn([projectId, "description"])).toBe(
      "stale realtime row",
    );
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).not.toHaveBeenCalled();
    expect(
      mockedWebappClient.conat_client.refreshProjectHostRouting,
    ).not.toHaveBeenCalled();
  });

  it("keeps a newer local project state when a realtime upsert is older", async () => {
    const projectId = "00000000-0000-4000-8000-000000000005";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          title: "Stateful Project",
          state: ImmutableMap({
            state: "running",
            time: "2026-04-05T03:05:00.000Z",
          }),
        }),
      ],
    ]);
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        if (state.projects.project_map != null) {
          projectMap = state.projects.project_map;
        }
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.upsert",
      ts: Date.parse("2026-04-05T03:00:00.000Z"),
      account_id: "acct-1",
      project: {
        project_id: projectId,
        title: "Retitled Project",
        description: "fresh metadata",
        name: null,
        theme: null,
        host_id: null,
        owning_bay_id: "bay-0",
        users: {
          "acct-1": { group: "owner" },
        },
        state: {
          state: "opened",
          time: "2026-04-05T03:00:00.000Z",
        },
        last_active: { "acct-1": "2026-04-05T03:00:00.000Z" },
        last_edited: "2026-04-05T03:00:00.000Z",
        deleted: false,
      },
    });
    await flush();

    expect(projectMap.getIn([projectId, "title"])).toBe("Retitled Project");
    expect(projectMap.getIn([projectId, "description"])).toBe("fresh metadata");
    expect(projectMap.getIn([projectId, "state", "state"])).toBe("running");
    expect(projectMap.getIn([projectId, "state", "time"])).toBe(
      "2026-04-05T03:05:00.000Z",
    );
  });

  it("does not close an open project when a transient remove lands during an active move", async () => {
    const projectId = "00000000-0000-4000-8000-000000000002";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          host_id: "host-old",
          title: "Moving Project",
        }),
      ],
    ]);
    openProjects = List([projectId]);
    const projectStore = ImmutableMap({
      move_lro: ImmutableMap({
        op_id: "move-op-1",
        summary: { status: "running" },
      }),
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      getProjectStore: jest.fn(() => projectStore),
      _set_state: jest.fn((state) => {
        if (state.projects.project_map != null) {
          projectMap = state.projects.project_map;
        }
        if (state.projects.open_projects != null) {
          openProjects = state.projects.open_projects;
        }
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);
    const setProjectClosedSpy = jest.spyOn(actions, "set_project_closed");

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.remove",
      ts: Date.now(),
      account_id: "acct-1",
      project_id: projectId,
    });
    await flush();

    expect(projectMap.has(projectId)).toBe(true);
    expect(openProjects.includes(projectId)).toBe(true);
    expect(setProjectClosedSpy).not.toHaveBeenCalled();
  });

  it("bootstraps remote shared projects from account_project_index on init", async () => {
    mockedWebappClient.async_query.mockResolvedValueOnce({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id: "project-remote",
            owning_bay_id: "bay-0",
            host_id: "host-1",
            title: "Shared Remote Project",
            description: "visible from projection",
            theme: { color: "#112233" },
            users_summary: {
              "acct-1": { group: "collaborator" },
            },
            state_summary: { state: "running" },
            last_activity_at: "2026-04-05T03:00:00.000Z",
            sort_key: "2026-04-05T03:00:00.000Z",
            updated_at: "2026-04-05T03:00:01.000Z",
            is_hidden: false,
          },
        ],
      },
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    expect(mockedWebappClient.async_query).toHaveBeenCalledWith({
      query: {
        account_project_index: [
          expect.objectContaining({
            account_id: "acct-1",
          }),
        ],
      },
      options: [{ limit: 2000 }],
    });
    expect(projectMap.getIn(["project-remote", "title"])).toBe(
      "Shared Remote Project",
    );
    expect(projectMap.getIn(["project-remote", "owning_bay_id"])).toBe("bay-0");
    expect(projectMap.getIn(["project-remote", "state", "state"])).toBe(
      "running",
    );
  });

  it("keeps a newer local moved host when projected bootstrap rows are older", async () => {
    const projectId = "00000000-0000-4000-8000-000000000003";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          host_id: "host-new",
          title: "Moved Project",
        }),
      ],
    ]);
    openProjects = List([projectId]);
    mockedWebappClient.async_query.mockResolvedValueOnce({
      query: {
        account_project_index: [
          {
            account_id: "acct-1",
            project_id: projectId,
            owning_bay_id: "bay-0",
            host_id: "host-old",
            title: "Moved Project",
            description: "stale projection",
            theme: null,
            users_summary: {
              "acct-1": { group: "owner" },
            },
            state_summary: { state: "running" },
            last_activity_at: "2026-04-05T03:00:00.000Z",
            sort_key: "2026-04-05T03:00:00.000Z",
            updated_at: "2026-04-05T03:00:01.000Z",
            is_hidden: false,
          },
        ],
      },
    });
    const projectStore = ImmutableMap({
      move_lro: ImmutableMap({
        summary: {
          status: "succeeded",
          updated_at: "2026-04-05T03:05:00.000Z",
        },
      }),
    });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      getProjectStore: jest.fn(() => projectStore),
      _set_state: jest.fn((state) => {
        if (state.projects.project_map != null) {
          projectMap = state.projects.project_map;
        }
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    expect(projectMap.getIn([projectId, "host_id"])).toBe("host-new");
    expect(projectMap.getIn([projectId, "description"])).toBe(
      "stale projection",
    );
  });

  it("keeps a newer local project state when projected bootstrap rows are older", async () => {
    const projectId = "00000000-0000-4000-8000-000000000006";
    projectMap = ImmutableMap<string, any>([
      [
        projectId,
        ImmutableMap({
          title: "Projected State Project",
          state: ImmutableMap({
            state: "running",
            time: "2026-04-05T03:05:00.000Z",
          }),
        }),
      ],
    ]);
    mockedWebappClient.async_query
      .mockResolvedValueOnce({
        query: {
          account_project_index: [
            {
              account_id: "acct-1",
              project_id: projectId,
              owning_bay_id: "bay-0",
              host_id: null,
              title: "Projected State Project",
              description: "projected metadata",
              theme: null,
              users_summary: {
                "acct-1": { group: "owner" },
              },
              state_summary: {
                state: "opened",
                time: "2026-04-05T03:00:00.000Z",
              },
              last_activity_at: "2026-04-05T03:00:00.000Z",
              sort_key: "2026-04-05T03:00:00.000Z",
              updated_at: "2026-04-05T03:00:01.000Z",
              is_hidden: false,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        query: { projects: [] },
      });
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn((state) => {
        if (state.projects.project_map != null) {
          projectMap = state.projects.project_map;
        }
      }),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    expect(projectMap.getIn([projectId, "description"])).toBe(
      "projected metadata",
    );
    expect(projectMap.getIn([projectId, "state", "state"])).toBe("running");
    expect(projectMap.getIn([projectId, "state", "time"])).toBe(
      "2026-04-05T03:05:00.000Z",
    );
  });

  it("refreshes the current projects table on history-gap without forcing all projects", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("history-gap", {
      requested_start_seq: 1,
      effective_start_seq: 5,
      oldest_retained_seq: 5,
      newest_retained_seq: 10,
    });
    await flush();

    expect(refreshProjectsTableMock).toHaveBeenCalledTimes(1);
  });

  it("forwards project detail invalidation feed events to the project field helper", async () => {
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return ImmutableMap({ account_id: "acct-1" });
        }
        return ImmutableMap();
      }),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    const feed = await getSharedAccountDStreamMock.mock.results[0].value;
    feed.emit("change", {
      type: "project.detail.invalidate",
      ts: Date.now(),
      account_id: "acct-1",
      project_id: "project-1",
      fields: ["launcher", "snapshots"],
    });
    await flush();

    expect(invalidateProjectFieldsMock).toHaveBeenCalledWith({
      project_id: "project-1",
      fields: ["launcher", "snapshots"],
    });
  });

  it("waits for the account store is_ready event before attaching the realtime feed", async () => {
    class MockAccountStore extends EventEmitter {
      private ready = false;

      get(key: string) {
        if (key === "account_id") {
          return this.ready ? "acct-1" : undefined;
        }
        if (key === "is_ready") {
          return this.ready;
        }
        return undefined;
      }

      setReady(): void {
        this.ready = true;
        this.emit("is_ready");
      }
    }

    const accountStore = new MockAccountStore();
    let reduxSubscriber: (() => void) | undefined;
    const redux = {
      getStore: jest.fn((name: string) => {
        if (name === "account") {
          return accountStore as any;
        }
        return ImmutableMap();
      }),
      reduxStore: {
        subscribe: jest.fn((cb: () => void) => {
          reduxSubscriber = cb;
          return jest.fn();
        }),
      },
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getTable: jest.fn(),
      getProjectActions: jest.fn(() => ({
        save_all_files: jest.fn(),
      })),
    } as any;
    const actions = new ProjectsActions("projects", redux);

    actions._init();
    await flush();

    expect(getSharedAccountDStreamMock).not.toHaveBeenCalled();

    accountStore.setReady();
    reduxSubscriber?.();
    await flush();

    expect(getSharedAccountDStreamMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
      maxListeners: 100,
    });
  });
});
