import { Map as ImmutableMap } from "immutable";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
    async_wait: jest.fn(),
  },
}));

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "acct-1",
    conat_client: {
      hub: {
        projects: {
          setProjectSshKey: jest.fn(async () => undefined),
          deleteProjectSshKey: jest.fn(async () => undefined),
        },
      },
      projectApi: jest.fn(() => ({
        system: {
          updateSshKeys: jest.fn(async () => undefined),
        },
      })),
    },
    project_client: {
      create: jest.fn(async () => "project-created"),
    },
    async_query: jest.fn(async () => undefined),
  },
}));

const mockedStore = store as jest.Mocked<typeof store>;
const mockedWebappClient = webapp_client as jest.Mocked<typeof webapp_client>;

describe("ProjectsActions project metadata updates", () => {
  const project_id = "project-1";
  const baseProjectMap = ImmutableMap([
    [
      project_id,
      ImmutableMap({
        title: "Old title",
        description: "Old description",
        name: "old-name",
      }),
    ],
  ]);

  function makeActions() {
    const async_log = jest.fn(async () => undefined);
    const redux = {
      getStore: jest.fn((name) =>
        name === "account" ? { get: jest.fn(() => "acct-1") } : {},
      ),
      _set_state: jest.fn(),
      removeActions: jest.fn(),
      getProjectActions: jest.fn(() => ({ async_log })),
    } as any;
    const actions = new ProjectsActions("projects", redux) as any;
    actions.have_project = jest.fn(async () => true);
    return { actions, async_log, redux };
  }

  beforeEach(() => {
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? baseProjectMap : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return baseProjectMap.getIn(path.slice(1) as any);
    });
    mockedStore.async_wait.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ["set_project_title", "title", "New title"],
    ["set_project_description", "description", "New description"],
    ["set_project_name", "name", "new-name"],
  ] as const)(
    "%s bypasses synced table writes that can carry unrelated row state",
    async (method, field, value) => {
      const { actions, async_log, redux } = makeActions();
      actions.projects_table_set = jest.fn(async () => {
        throw Error(
          "FATAL: error setting 'users' -- changing collaborator group via user_set_query is not allowed",
        );
      });
      actions.projects_query_set = jest.fn(async () => undefined);

      await expect(actions[method](project_id, value)).resolves.toBeUndefined();

      expect(actions.projects_query_set).toHaveBeenCalledWith({
        project_id,
        [field]: value,
      });
      expect(actions.projects_table_set).not.toHaveBeenCalled();
      expect(async_log).toHaveBeenCalledWith({
        event: "set",
        [field]: value,
      });
      expect(redux._set_state).toHaveBeenCalled();
    },
  );

  it("rolls back the local optimistic update when the direct query fails", async () => {
    const { actions, redux } = makeActions();
    const err = Error("write failed");
    actions.projects_table_set = jest.fn(async () => undefined);
    actions.projects_query_set = jest.fn(async () => {
      throw err;
    });

    await expect(
      actions.set_project_title(project_id, "New title"),
    ).rejects.toBe(err);

    expect(redux._set_state).toHaveBeenCalledTimes(2);
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("New title");
    expect(
      redux._set_state.mock.calls[1][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Old title");
  });

  it("setProjectTheme bypasses synced table writes that require project-host routing", async () => {
    const { actions, async_log, redux } = makeActions();
    actions.projects_table_set = jest.fn(async () => {
      throw Error("host routing info unavailable");
    });
    actions.projects_query_set = jest.fn(async () => undefined);
    const theme = {
      color: "#123456",
      accent_color: "#abcdef",
      icon: "rocket",
      image_blob: null,
    };

    await expect(
      actions.setProjectTheme(project_id, theme),
    ).resolves.toBeUndefined();

    expect(actions.projects_query_set).toHaveBeenCalledWith({
      project_id,
      theme,
    });
    expect(actions.projects_table_set).not.toHaveBeenCalled();
    expect(async_log).toHaveBeenCalledWith({
      event: "set",
      theme,
    });
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map
        .getIn([project_id, "theme"])
        .toJS(),
    ).toEqual(theme);
  });

  it("does not reject metadata saves when best-effort logging fails", async () => {
    const { actions, redux } = makeActions();
    const err = Error("log failed");
    const async_log = jest.fn(async () => {
      throw err;
    });
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    redux.getProjectActions.mockReturnValue({ async_log });
    actions.projects_query_set = jest.fn(async () => undefined);

    await expect(
      actions.set_project_title(project_id, "New title"),
    ).resolves.toBeUndefined();
    await Promise.resolve();

    expect(async_log).toHaveBeenCalledWith({
      event: "set",
      title: "New title",
    });
    expect(warn).toHaveBeenCalledWith(
      "error recording project metadata log entry",
      {
        project_id,
        err,
        event: {
          event: "set",
          title: "New title",
        },
      },
    );
    warn.mockRestore();
  });

  it("updates the local project store immediately after adding a project SSH key", async () => {
    const projectMapWithUsers = ImmutableMap([
      [
        project_id,
        ImmutableMap({
          users: ImmutableMap({
            "acct-1": ImmutableMap({
              group: "owner",
            }),
          }),
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMapWithUsers : undefined,
    );
    const { actions, redux } = makeActions();
    actions.updateAuthorizedKeys = jest.fn(async () => undefined);

    await actions.add_ssh_key_to_project({
      project_id,
      fingerprint: "fp-1",
      title: "laptop",
      value: "ssh-ed25519 AAAATEST laptop",
    });

    expect(
      mockedWebappClient.conat_client.hub.projects.setProjectSshKey,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        fingerprint: "fp-1",
        title: "laptop",
        value: "ssh-ed25519 AAAATEST laptop",
      }),
    );
    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "users",
        "acct-1",
        "ssh_keys",
        "fp-1",
        "title",
      ]),
    ).toBe("laptop");
  });

  it("updates the local project store immediately after deleting a project SSH key", async () => {
    const projectMapWithUsers = ImmutableMap([
      [
        project_id,
        ImmutableMap({
          users: ImmutableMap({
            "acct-1": ImmutableMap({
              group: "owner",
              ssh_keys: ImmutableMap({
                "fp-1": ImmutableMap({
                  title: "laptop",
                  value: "ssh-ed25519 AAAATEST laptop",
                  creation_date: 1,
                }),
              }),
            }),
          }),
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMapWithUsers : undefined,
    );
    const { actions, redux } = makeActions();
    actions.updateAuthorizedKeys = jest.fn(async () => undefined);

    await actions.delete_ssh_key_from_project({
      project_id,
      fingerprint: "fp-1",
    });

    expect(
      mockedWebappClient.conat_client.hub.projects.deleteProjectSshKey,
    ).toHaveBeenCalledWith({
      project_id,
      fingerprint: "fp-1",
    });
    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "users",
        "acct-1",
        "ssh_keys",
        "fp-1",
      ]),
    ).toBeUndefined();
  });

  it("returns the created project once the local feed catches up", async () => {
    const { actions } = makeActions();
    mockedWebappClient.project_client.create.mockResolvedValueOnce(
      "project-created-1",
    );

    await expect(
      actions.create_project({ title: "New project", start: true }),
    ).resolves.toBe("project-created-1");

    expect(mockedWebappClient.project_client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "New project",
        start: true,
      }),
    );
    expect(mockedStore.async_wait).toHaveBeenCalled();
    expect(mockedWebappClient.async_query).not.toHaveBeenCalled();
  });

  it("falls back to a direct project query when feed wait times out", async () => {
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? undefined : undefined,
    );
    mockedStore.getIn.mockReturnValue(undefined);
    mockedStore.async_wait.mockRejectedValueOnce("timeout");
    mockedWebappClient.project_client.create.mockResolvedValueOnce(
      "project-created-2",
    );
    mockedWebappClient.async_query.mockResolvedValueOnce({
      query: {
        projects: [
          {
            project_id: "project-created-2",
            title: "Recovered project",
            description: "Recovered description",
            name: null,
            theme: null,
            host_id: "host-1",
            owning_bay_id: "bay-0",
            users: { "acct-1": { group: "owner" } },
            state: { state: "opened" },
            last_active: {},
            last_edited: "2026-05-03T00:00:00.000Z",
            last_backup: null,
            deleted: false,
          },
        ],
      },
    });
    const { actions, redux } = makeActions();

    await expect(
      actions.create_project({ title: "Recovered project", start: true }),
    ).resolves.toBe("project-created-2");

    expect(mockedWebappClient.async_query).toHaveBeenCalledWith({
      query: {
        projects: [
          expect.objectContaining({
            project_id: "project-created-2",
          }),
        ],
      },
    });
    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        "project-created-2",
        "title",
      ]),
    ).toBe("Recovered project");
  });

  it("keeps a newer local last_edited when direct bootstrap rows are older", async () => {
    let projectMap = ImmutableMap<string, any>();
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMap : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    mockedStore.async_wait.mockRejectedValueOnce("timeout");
    mockedWebappClient.project_client.create.mockResolvedValueOnce(
      "project-created-4",
    );
    mockedWebappClient.async_query.mockImplementationOnce(async () => {
      projectMap = ImmutableMap<string, any>([
        [
          "project-created-4",
          ImmutableMap({
            title: "Live Feed Title",
            last_edited: new Date("2026-05-03T00:05:00.000Z"),
          }),
        ],
      ]);
      return {
        query: {
          projects: [
            {
              project_id: "project-created-4",
              title: "Recovered project",
              description: "Recovered description",
              name: null,
              theme: null,
              host_id: "host-1",
              owning_bay_id: "bay-0",
              users: { "acct-1": { group: "owner" } },
              state: { state: "opened" },
              last_active: {},
              last_edited: "2026-05-03T00:00:00.000Z",
              last_backup: null,
              deleted: false,
            },
          ],
        },
      };
    });
    const { actions, redux } = makeActions();

    await expect(
      actions.create_project({ title: "Recovered project", start: true }),
    ).resolves.toBe("project-created-4");

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        "project-created-4",
        "title",
      ]),
    ).toBe("Recovered project");
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map
        .getIn(["project-created-4", "last_edited"])
        .toISOString(),
    ).toBe("2026-05-03T00:05:00.000Z");
  });

  it("keeps a newer local last_backup when direct bootstrap rows are older", async () => {
    let projectMap = ImmutableMap<string, any>();
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMap : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    mockedStore.async_wait.mockRejectedValueOnce("timeout");
    mockedWebappClient.project_client.create.mockResolvedValueOnce(
      "project-created-5",
    );
    mockedWebappClient.async_query.mockImplementationOnce(async () => {
      projectMap = ImmutableMap<string, any>([
        [
          "project-created-5",
          ImmutableMap({
            title: "Live Feed Title",
            last_backup: new Date("2026-05-03T00:05:00.000Z"),
          }),
        ],
      ]);
      return {
        query: {
          projects: [
            {
              project_id: "project-created-5",
              title: "Recovered project",
              description: "Recovered description",
              name: null,
              theme: null,
              host_id: "host-1",
              owning_bay_id: "bay-0",
              users: { "acct-1": { group: "owner" } },
              state: { state: "opened" },
              last_active: {},
              last_edited: "2026-05-03T00:00:00.000Z",
              last_backup: "2026-05-03T00:00:00.000Z",
              deleted: false,
            },
          ],
        },
      };
    });
    const { actions, redux } = makeActions();

    await expect(
      actions.create_project({ title: "Recovered project", start: true }),
    ).resolves.toBe("project-created-5");

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map
        .getIn(["project-created-5", "last_backup"])
        .toISOString(),
    ).toBe("2026-05-03T00:05:00.000Z");
  });

  it("keeps a newer local state when a synced projects table snapshot is older", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local title",
          state: ImmutableMap({
            state: "running",
            time: "2026-05-03T00:05:00.000Z",
          }),
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(
      ImmutableMap<string, any>([
        [
          project_id,
          ImmutableMap({
            title: "Table title",
            state: ImmutableMap({
              state: "opened",
              time: "2026-05-03T00:00:00.000Z",
            }),
          }),
        ],
      ]),
    );

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Table title");
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "state",
        "state",
      ]),
    ).toBe("running");
  });

  it("accepts the incoming host from a synced projects table snapshot after a move", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          host_id: "host-old",
          title: "Moved project",
        }),
      ],
    ]);
    const projectStore = ImmutableMap({
      move_lro: ImmutableMap({
        summary: {
          status: "succeeded",
          updated_at: "2026-05-03T00:05:00.000Z",
        },
      }),
    });
    mockedStore.get.mockImplementation((key) =>
      key === "project_map" ? projectMap : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    const { actions, redux } = makeActions();
    redux.getProjectStore = jest.fn(() => projectStore);

    actions.applyProjectsTableSnapshot(
      ImmutableMap<string, any>([
        [
          project_id,
          ImmutableMap({
            host_id: "host-new",
            title: "Moved project",
          }),
        ],
      ]),
    );

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "host_id",
      ]),
    ).toBe("host-new");
  });

  it("keeps newer local last_active values when a synced projects table snapshot is older", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local title",
          last_active: ImmutableMap({
            "acct-1": new Date("2026-05-03T00:05:00.000Z"),
          }),
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(
      ImmutableMap<string, any>([
        [
          project_id,
          ImmutableMap({
            title: "Table title",
            last_active: ImmutableMap({
              "acct-1": new Date("2026-05-03T00:00:00.000Z"),
            }),
          }),
        ],
      ]),
    );

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Table title");
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map
        .getIn([project_id, "last_active", "acct-1"])
        .toISOString(),
    ).toBe("2026-05-03T00:05:00.000Z");
  });

  it("keeps newer local last_backup values when a synced projects table snapshot is older", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local title",
          last_backup: new Date("2026-05-03T00:05:00.000Z"),
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(
      ImmutableMap<string, any>([
        [
          project_id,
          ImmutableMap({
            title: "Table title",
            last_backup: new Date("2026-05-03T00:00:00.000Z"),
          }),
        ],
      ]),
    );

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Table title");
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map
        .getIn([project_id, "last_backup"])
        .toISOString(),
    ).toBe("2026-05-03T00:05:00.000Z");
  });

  it("keeps local ssh_keys when a synced projects table snapshot updates users", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local title",
          users: ImmutableMap({
            "acct-1": ImmutableMap({
              group: "owner",
              ssh_keys: ImmutableMap({
                "fp-1": ImmutableMap({
                  title: "laptop",
                  value: "ssh-ed25519 AAAATEST laptop",
                  creation_date: 1,
                }),
              }),
            }),
          }),
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(
      ImmutableMap<string, any>([
        [
          project_id,
          ImmutableMap({
            title: "Table title",
            users: ImmutableMap({
              "acct-1": ImmutableMap({
                group: "owner",
              }),
            }),
          }),
        ],
      ]),
    );

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Table title");
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "users",
        "acct-1",
        "ssh_keys",
        "fp-1",
        "title",
      ]),
    ).toBe("laptop");
  });

  it("keeps projection-only projects that are absent from a synced table snapshot", () => {
    const remoteProjectId = "project-remote";
    const projectMap = ImmutableMap<string, any>([
      [
        remoteProjectId,
        ImmutableMap({
          title: "Shared Remote Project",
          __projection_only: true,
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(ImmutableMap<string, any>());

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        remoteProjectId,
        "title",
      ]),
    ).toBe("Shared Remote Project");
  });

  it("removes non-projection projects that are absent from a synced table snapshot and closes them if open", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local Project",
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map"
        ? projectMap
        : key === "open_projects"
          ? [project_id]
          : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    const { actions, redux } = makeActions();
    actions.set_project_closed = jest.fn();

    actions.applyProjectsTableSnapshot(ImmutableMap<string, any>());

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.has(project_id),
    ).toBe(false);
    expect(actions.set_project_closed).toHaveBeenCalledWith(project_id);
  });

  it("keeps an open project missing from a synced table snapshot while an account-level move is running", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Moving Project",
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map"
        ? projectMap
        : key === "open_projects"
          ? [project_id]
          : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    const { actions, redux } = makeActions();
    actions.set_project_closed = jest.fn();

    actions.handleRealtimeFeedChange({
      type: "lro.summary",
      ts: Date.now(),
      account_id: "acct-1",
      summary: {
        op_id: "move-op-1",
        kind: "project-move",
        scope_type: "project",
        scope_id: project_id,
        status: "running",
        updated_at: new Date(),
      },
    });
    actions.applyProjectsTableSnapshot(ImmutableMap<string, any>());

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.has(project_id),
    ).toBe(true);
    expect(actions.set_project_closed).not.toHaveBeenCalled();
  });

  it("does not close an open project that is present in a synced table snapshot", () => {
    const projectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Local Project",
        }),
      ],
    ]);
    const incomingProjectMap = ImmutableMap<string, any>([
      [
        project_id,
        ImmutableMap({
          title: "Renamed Project",
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map"
        ? projectMap
        : key === "open_projects"
          ? [project_id]
          : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    const { actions, redux } = makeActions();
    actions.set_project_closed = jest.fn();

    actions.applyProjectsTableSnapshot(incomingProjectMap);

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        project_id,
        "title",
      ]),
    ).toBe("Renamed Project");
    expect(actions.set_project_closed).not.toHaveBeenCalled();
  });

  it("removes a missing kiosk project while preserving unrelated local projects", () => {
    const kioskProjectId = "project-kiosk";
    const otherProjectId = "project-other";
    const projectMap = ImmutableMap<string, any>([
      [
        kioskProjectId,
        ImmutableMap({
          title: "Kiosk Project",
        }),
      ],
      [
        otherProjectId,
        ImmutableMap({
          title: "Other Project",
        }),
      ],
    ]);
    mockedStore.get.mockImplementation((key) =>
      key === "project_map"
        ? projectMap
        : key === "open_projects"
          ? [kioskProjectId]
          : undefined,
    );
    mockedStore.getIn.mockImplementation((path) => {
      if (path[0] !== "project_map") {
        return undefined;
      }
      return projectMap.getIn(path.slice(1) as any);
    });
    const { actions, redux } = makeActions();
    actions.set_project_closed = jest.fn();

    actions.applyProjectsTableSnapshot(ImmutableMap<string, any>(), {
      mergeIntoExisting: true,
      removeMissingProjectIds: [kioskProjectId],
    });

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.has(
        kioskProjectId,
      ),
    ).toBe(false);
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        otherProjectId,
        "title",
      ]),
    ).toBe("Other Project");
    expect(actions.set_project_closed).toHaveBeenCalledWith(kioskProjectId);
  });

  it("keeps a projection-only kiosk project when the synced table snapshot is empty", () => {
    const kioskProjectId = "project-kiosk-remote";
    const projectMap = ImmutableMap<string, any>([
      [
        kioskProjectId,
        ImmutableMap({
          title: "Shared Remote Project",
          __projection_only: true,
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
    const { actions, redux } = makeActions();

    actions.applyProjectsTableSnapshot(ImmutableMap<string, any>(), {
      mergeIntoExisting: true,
      removeMissingProjectIds: [kioskProjectId],
    });

    expect(redux._set_state).toHaveBeenCalled();
    expect(
      redux._set_state.mock.calls[0][0].projects.project_map.getIn([
        kioskProjectId,
        "title",
      ]),
    ).toBe("Shared Remote Project");
  });

  it("still fails when feed wait times out and direct bootstrap finds nothing", async () => {
    mockedStore.async_wait.mockRejectedValueOnce("timeout");
    mockedWebappClient.project_client.create.mockResolvedValueOnce(
      "project-created-3",
    );
    mockedWebappClient.async_query.mockResolvedValueOnce({
      query: { projects: [] },
    });
    const { actions } = makeActions();

    await expect(
      actions.create_project({ title: "Missing project", start: true }),
    ).rejects.toBe("timeout");
  });
});
