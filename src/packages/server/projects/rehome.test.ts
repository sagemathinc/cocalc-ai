export {};

let queryMock: jest.Mock;
let connectMock: jest.Mock;
let clientQueryMock: jest.Mock;
let clientReleaseMock: jest.Mock;
let isAdminMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let resolveProjectBayDirectMock: jest.Mock;
let projectControlMock: jest.Mock;
let acceptRehomeMock: jest.Mock;
let rehomeMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let drainAccountProjectIndexProjectionMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
    connect: connectMock,
  })),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
  resolveProjectBayDirect: (...args: any[]) =>
    resolveProjectBayDirectMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  getInterBayBridge: jest.fn(() => ({
    projectControl: (...args: any[]) => projectControlMock(...args),
  })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/account-project-index-projector", () => ({
  drainAccountProjectIndexProjection: (...args: any[]) =>
    drainAccountProjectIndexProjectionMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

describe("project rehome", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    clientQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: [
            { column_name: "project_id" },
            { column_name: "owning_bay_id" },
            { column_name: "title" },
            { column_name: "users" },
            { column_name: "deleted" },
          ],
        };
      }
      return { rows: [] };
    });
    clientReleaseMock = jest.fn();
    connectMock = jest.fn(async () => ({
      query: clientQueryMock,
      release: clientReleaseMock,
    }));
    isAdminMock = jest.fn(async () => true);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 0,
    }));
    resolveProjectBayDirectMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 0,
    }));
    acceptRehomeMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-0",
      owning_bay_id: "bay-2",
      status: "rehomed",
    }));
    rehomeMock = jest.fn(async () => ({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-7",
      owning_bay_id: "bay-2",
      status: "rehomed",
    }));
    projectControlMock = jest.fn((bay_id: string) => ({
      acceptRehome: acceptRehomeMock,
      rehome: rehomeMock,
      bay_id,
    }));
    appendProjectOutboxEventForProjectMock = jest.fn(async () => "event-id");
    drainAccountProjectIndexProjectionMock = jest.fn(async () => ({}));
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
  });

  it("routes rehome requests to the current owning bay", async () => {
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 3,
    }));
    const { rehomeProject } = await import("./rehome");

    const result = await rehomeProject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
    });

    expect(result.owning_bay_id).toBe("bay-2");
    expect(projectControlMock).toHaveBeenCalledWith("bay-7", {
      timeout_ms: 60_000,
    });
    expect(rehomeMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
      epoch: 3,
    });
    expect(acceptRehomeMock).not.toHaveBeenCalled();
  });

  it("accepts on destination before flipping source ownership", async () => {
    const order: string[] = [];
    acceptRehomeMock = jest.fn(async () => {
      order.push("accept-destination");
      return {
        project_id: PROJECT_ID,
        previous_bay_id: "bay-0",
        owning_bay_id: "bay-2",
        status: "rehomed",
      };
    });
    projectControlMock = jest.fn(() => ({
      acceptRehome: acceptRehomeMock,
      rehome: rehomeMock,
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT to_jsonb(projects.*) AS project")) {
        return {
          rows: [
            {
              project: {
                project_id: PROJECT_ID,
                owning_bay_id: "bay-0",
                title: "Project",
                users: {},
                deleted: false,
              },
            },
          ],
        };
      }
      if (sql.includes("UPDATE projects")) {
        order.push("flip-source");
      }
      return { rows: [] };
    });
    const { rehomeProject } = await import("./rehome");

    const result = await rehomeProject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      dest_bay_id: "bay-2",
    });

    expect(result).toEqual({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-0",
      owning_bay_id: "bay-2",
      status: "rehomed",
    });
    expect(order).toEqual(["accept-destination", "flip-source"]);
    expect(acceptRehomeMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      source_bay_id: "bay-0",
      dest_bay_id: "bay-2",
      project: {
        project_id: PROJECT_ID,
        owning_bay_id: "bay-0",
        title: "Project",
        users: {},
        deleted: false,
      },
      epoch: 0,
    });
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE account_project_index"),
      [PROJECT_ID, "bay-2"],
    );
  });

  it("destination accept upserts the project row as locally owned", async () => {
    const { acceptProjectRehome } = await import("./rehome");

    await expect(
      acceptProjectRehome({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        source_bay_id: "bay-1",
        dest_bay_id: "bay-0",
        project: {
          project_id: PROJECT_ID,
          owning_bay_id: "bay-1",
          title: "Project",
          users: {},
          deleted: false,
        },
      }),
    ).resolves.toEqual({
      project_id: PROJECT_ID,
      previous_bay_id: "bay-1",
      owning_bay_id: "bay-0",
      status: "rehomed",
    });

    expect(clientQueryMock).toHaveBeenCalledWith("BEGIN");
    expect(clientQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("ON CONFLICT (project_id) DO UPDATE"),
      [PROJECT_ID, "bay-0", "Project", {}, false],
    );
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: expect.anything(),
      event_type: "project.summary_changed",
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
    expect(clientQueryMock).toHaveBeenCalledWith("COMMIT");
    expect(drainAccountProjectIndexProjectionMock).toHaveBeenCalledWith({
      bay_id: "bay-0",
      dry_run: false,
      limit: 100,
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      default_bay_id: "bay-0",
    });
  });
});
