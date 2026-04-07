import { EventEmitter } from "events";
import { List, Map as ImmutableMap } from "immutable";

import { accountFeedStreamName } from "../../conat/hub/api/account-feed";

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

  const webappClient = Object.assign(new EventEmitter(), {
    is_signed_in: jest.fn(() => true),
    conat_client: Object.assign(new EventEmitter(), {
      dstream: jest.fn(async () => new MockFeed()),
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
  conat_client: EventEmitter & {
    dstream: jest.Mock;
  };
};

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

    expect(mockedWebappClient.conat_client.dstream).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
    });

    const feed =
      await mockedWebappClient.conat_client.dstream.mock.results[0].value;
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

    const feed =
      await mockedWebappClient.conat_client.dstream.mock.results[0].value;
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

    const feed =
      await mockedWebappClient.conat_client.dstream.mock.results[0].value;
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

    expect(mockedWebappClient.conat_client.dstream).not.toHaveBeenCalled();

    accountStore.setReady();
    reduxSubscriber?.();
    await flush();

    expect(mockedWebappClient.conat_client.dstream).toHaveBeenCalledWith({
      account_id: "acct-1",
      name: accountFeedStreamName(),
      ephemeral: true,
    });
  });
});
