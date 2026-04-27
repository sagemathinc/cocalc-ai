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
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectsActions realtime feed", () => {
  let projectMap = ImmutableMap<string, any>();

  beforeEach(() => {
    jest.clearAllMocks();
    refreshProjectsTableMock.mockResolvedValue(undefined);
    projectMap = ImmutableMap<string, any>();
    mockedWebappClient.is_signed_in.mockReturnValue(true);
    getSharedAccountDStreamMock.mockResolvedValue(new MockFeed());
    mockedStore.get.mockImplementation((key: string) => {
      switch (key) {
        case "project_map":
          return projectMap;
        case "open_projects":
          return List();
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
    mockedStore.get.mockImplementation((key: string) => {
      switch (key) {
        case "project_map":
          return projectMap;
        case "open_projects":
          return List([projectId]);
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
    expect(mockedWebappClient.conat_client.reconnect).toHaveBeenCalled();
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
