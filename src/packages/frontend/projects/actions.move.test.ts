import { List, Map as ImmutableMap } from "immutable";

import { redux as appRedux } from "@cocalc/frontend/app-framework";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { refresh_projects_table } from "./table";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
  },
}));

jest.mock("./table", () => ({
  refresh_projects_table: jest.fn(async () => undefined),
  switch_to_project: jest.fn(),
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    conat_client: {
      lroWait: jest.fn(async () => ({
        status: "succeeded",
      })),
      hub: {
        lro: {
          get: jest.fn(async () => ({
            status: "succeeded",
          })),
        },
      },
      releaseProjectHostRouting: jest.fn(),
      refreshProjectHostRouting: jest.fn(),
    },
    async_query: jest.fn(async () => undefined),
  },
}));

const mockedStore = store as jest.Mocked<typeof store>;
const mockedRefreshProjectsTable =
  refresh_projects_table as jest.MockedFunction<typeof refresh_projects_table>;
const mockedWebappClient = webapp_client as jest.Mocked<typeof webapp_client>;

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProjectsActions move flow", () => {
  const project_id = "22222222-2222-4222-8222-222222222222";
  let projectMap = ImmutableMap<string, any>();

  beforeEach(() => {
    jest.clearAllMocks();
    projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          host_id: "host-old",
          region: "us-central1",
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key: string) => {
      switch (key) {
        case "project_map":
          return projectMap;
        case "open_projects":
          return List([project_id]);
        default:
          return undefined;
      }
    });
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    mockedRefreshProjectsTable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("keeps the destination host when a stale projects-table refresh would revert it", async () => {
    const projectActions = {
      project_id,
      setState: jest.fn(),
      resetProjectHostRuntime: jest.fn(),
      trackMoveOp: jest.fn(),
    };
    const redux = {
      getStore: jest.fn(() => ({})),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(() => projectActions),
    } as any;
    jest
      .spyOn(appRedux, "getProjectActions")
      .mockReturnValue(projectActions as any);
    const actions = new ProjectsActions("projects", redux);
    jest
      .spyOn(actions as any, "ensure_host_info")
      .mockResolvedValue(undefined as any);
    mockedRefreshProjectsTable.mockImplementation(async () => {
      projectMap = projectMap.setIn([project_id, "host_id"], "host-old");
    });

    (actions as any).watchMoveLro(
      projectActions as any,
      {
        op_id: "move-op-1",
        scope_type: "project",
        scope_id: project_id,
      },
      {
        project_id,
        source_host_id: "host-old",
        dest_host_id: "host-new",
        dest_project_region: "us-west1",
      },
    );
    await flush();

    expect(mockedWebappClient.conat_client.lroWait).toHaveBeenCalledWith({
      op_id: "move-op-1",
      scope_type: "project",
      scope_id: project_id,
    });
    expect(projectMap.getIn([project_id, "host_id"])).toBe("host-new");
    expect(projectMap.getIn([project_id, "region"])).toBe("us-west1");
    expect(
      mockedWebappClient.conat_client.releaseProjectHostRouting,
    ).toHaveBeenCalledWith({ project_id });
    expect(
      mockedWebappClient.conat_client.refreshProjectHostRouting,
    ).toHaveBeenCalledWith({
      source_host_id: "host-old",
      dest_host_id: "host-new",
    });
    expect(projectActions.resetProjectHostRuntime).toHaveBeenCalled();
  });

  it("keeps the destination host when an older realtime upsert would revert it", async () => {
    const projectActions = {
      project_id,
      setState: jest.fn(),
      resetProjectHostRuntime: jest.fn(),
      trackMoveOp: jest.fn(),
    };
    const projectStore = ImmutableMap({
      move_lro: ImmutableMap({
        summary: {
          status: "succeeded",
          updated_at: "2026-04-05T03:05:00.000Z",
        },
      }),
    });
    const redux = {
      getStore: jest.fn(() => ({})),
      getProjectStore: jest.fn(() => projectStore),
      _set_state: jest.fn((state) => {
        projectMap = state.projects.project_map;
      }),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(() => projectActions),
    } as any;
    const actions = new ProjectsActions("projects", redux);
    jest
      .spyOn(appRedux, "getProjectActions")
      .mockReturnValue(projectActions as any);

    projectMap = projectMap.setIn([project_id, "host_id"], "host-new");

    (actions as any).applyProjectFeedUpsert(
      {
        project_id,
        title: "Realtime Project",
        description: "stale realtime row",
        name: "realtime-project",
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
      new Date("2026-04-05T03:00:01.000Z").getTime(),
    );

    expect(projectMap.getIn([project_id, "host_id"])).toBe("host-new");
    expect(projectMap.getIn([project_id, "description"])).toBe(
      "stale realtime row",
    );
    expect(
      mockedWebappClient.conat_client.refreshProjectHostRouting,
    ).not.toHaveBeenCalled();
    expect(projectActions.resetProjectHostRuntime).not.toHaveBeenCalled();
  });
});
