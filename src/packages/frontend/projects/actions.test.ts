import { Map as ImmutableMap } from "immutable";

import { ProjectsActions } from "./actions";
import { store } from "./store";
import { webapp_client } from "@cocalc/frontend/webapp-client";

jest.mock("./store", () => ({
  store: {
    get: jest.fn(),
    getIn: jest.fn(),
    get_state: jest.fn(),
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
      getStore: jest.fn(() => ({})),
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
});
