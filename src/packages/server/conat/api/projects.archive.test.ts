export {};

let isAdminMock: jest.Mock;
let poolQueryMock: jest.Mock;
let poolConnectQueryMock: jest.Mock;
let poolConnectReleaseMock: jest.Mock;
let getBackupsMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayStopMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let assertProjectNotRehomingMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let routedClientCloseMock: jest.Mock;

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
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

jest.mock("@cocalc/server/projects/collaborators", () => ({
  __esModule: true,
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
    connect: async () => ({
      query: (...args: any[]) => poolConnectQueryMock(...args),
      release: (...args: any[]) => poolConnectReleaseMock(...args),
    }),
  })),
}));

jest.mock("@cocalc/database", () => ({
  __esModule: true,
  db: jest.fn(() => ({})),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  updateAuthorizedKeysOnHost: jest.fn(),
  takeStartProjectPhaseTimings: jest.fn(() => undefined),
  deleteProjectDataOnHost: (...args: any[]) =>
    deleteProjectDataOnHostMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitProjectRoutedClient: jest.fn(),
  conatWithProjectRoutingForAccount: jest.fn(() => ({
    close: (...args: any[]) => routedClientCloseMock(...args),
  })),
}));

jest.mock("@cocalc/conat/project/archive-info", () => ({
  __esModule: true,
  getBackups: (...args: any[]) => getBackupsMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectControl: jest.fn(() => ({
      stop: (...args: any[]) => interBayStopMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopy: jest.fn(),
  listCopiesForProject: jest.fn(async () => []),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: jest.fn(),
  updateLro: jest.fn(),
}));

jest.mock("@cocalc/server/projects/start-lro-progress", () => ({
  __esModule: true,
  mirrorStartLroProgress: jest.fn(),
}));

jest.mock("@cocalc/server/projects/start-lro-cleanup", () => ({
  __esModule: true,
  supersedeOlderProjectStartLros: jest.fn(),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: jest.fn(),
  publishLroSummary: jest.fn(),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn(),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-rehome-fence", () => ({
  __esModule: true,
  assertProjectNotRehoming: (...args: any[]) =>
    assertProjectNotRehomingMock(...args),
  withProjectRehomeWriteFence: jest.fn(),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  __esModule: true,
  publishProjectDetailInvalidationBestEffort: jest.fn(),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: jest.fn(),
  assertCollabAllowRemoteProjectAccess: jest.fn(),
}));

describe("projects.archiveProject", () => {
  beforeEach(() => {
    jest.resetModules();
    isAdminMock = jest.fn(async () => false);
    poolQueryMock = jest.fn();
    poolConnectQueryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0 };
      }
      return { rowCount: 1, rows: [] };
    });
    poolConnectReleaseMock = jest.fn();
    getBackupsMock = jest.fn(async () => [
      { id: "backup-1", time: new Date(), summary: {} },
    ]);
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-1",
      epoch: 7,
    }));
    interBayStopMock = jest.fn(async () => undefined);
    deleteProjectDataOnHostMock = jest.fn(async () => undefined);
    appendProjectOutboxEventForProjectMock = jest.fn(async () => undefined);
    assertProjectNotRehomingMock = jest.fn(async () => undefined);
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    routedClientCloseMock = jest.fn();
  });

  it("archives a provisioned project after confirming backups exist", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ group: "owner" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            host_id: "host-1",
            backup_repo_id: "repo-1",
            provisioned: true,
            state: { state: "running" },
          },
        ],
      });

    const { archiveProject } = await import("./projects");
    await expect(
      archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
      }),
    ).resolves.toBeUndefined();

    expect(getBackupsMock).toHaveBeenCalledWith({
      client: expect.any(Object),
      project_id: "proj-1",
      indexed_only: true,
    });
    expect(resolveProjectBayMock).toHaveBeenCalledWith("proj-1");
    expect(interBayStopMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      epoch: 7,
    });
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      host_id: "host-1",
    });
    expect(assertProjectNotRehomingMock).toHaveBeenCalledWith({
      db: expect.any(Object),
      project_id: "proj-1",
      action: "archive project",
    });
    expect(appendProjectOutboxEventForProjectMock).toHaveBeenCalledWith({
      db: expect.any(Object),
      event_type: "project.state_changed",
      project_id: "proj-1",
      default_bay_id: expect.any(String),
    });
    expect(publishProjectAccountFeedEventsBestEffortMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      default_bay_id: expect.any(String),
    });
    expect(routedClientCloseMock).toHaveBeenCalled();
  });

  it("refuses to archive when no backups exist yet", async () => {
    poolQueryMock
      .mockResolvedValueOnce({ rows: [{ group: "owner" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            host_id: "host-1",
            backup_repo_id: "repo-1",
            provisioned: true,
            state: { state: "opened" },
          },
        ],
      });
    getBackupsMock = jest.fn(async () => []);

    const { archiveProject } = await import("./projects");
    await expect(
      archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow(
      "project must have at least one backup before it can be archived",
    );

    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });
});
