export {};

let isAdminMock: jest.Mock;
let poolQueryMock: jest.Mock;
let poolConnectQueryMock: jest.Mock;
let poolConnectReleaseMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayStopMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let assertProjectNotRehomingMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let routedClientCloseMock: jest.Mock;
let getExplicitProjectRoutedClientMock: jest.Mock;
let assertCanPerformDestructiveStorageActionMock: jest.Mock;
let createProjectArchiveLifecycleJobMock: jest.Mock;
let updateProjectArchiveLifecycleJobMock: jest.Mock;

jest.mock("@cocalc/server/projects/archive-lifecycle-db", () => ({
  __esModule: true,
  createProjectArchiveLifecycleJob: (...args: any[]) =>
    createProjectArchiveLifecycleJobMock(...args),
  updateProjectArchiveLifecycleJob: (...args: any[]) =>
    updateProjectArchiveLifecycleJobMock(...args),
}));

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
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
  conatWithProjectRoutingForAccount: jest.fn(() => ({
    close: (...args: any[]) => routedClientCloseMock(...args),
  })),
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

jest.mock("@cocalc/server/projects/destructive-storage-actions", () => ({
  __esModule: true,
  assertCanPerformDestructiveStorageAction: (...args: any[]) =>
    assertCanPerformDestructiveStorageActionMock(...args),
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
    getExplicitProjectRoutedClientMock = jest.fn(async () => ({
      close: (...args: any[]) => routedClientCloseMock(...args),
    }));
    assertCanPerformDestructiveStorageActionMock = jest.fn(
      async () => undefined,
    );
    createProjectArchiveLifecycleJobMock = jest.fn(async () => ({
      id: "77777777-7777-4777-8777-777777777777",
    }));
    updateProjectArchiveLifecycleJobMock = jest.fn(async () => undefined);
  });

  it("archives a provisioned project with durable backup metadata", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "running" },
          host_status: "running",
          last_backup: new Date("2026-06-15T04:32:34.102Z"),
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

    expect(assertCanPerformDestructiveStorageActionMock).toHaveBeenCalledWith({
      account_id: "owner-1",
      project_id: "proj-1",
      action: "archive this project",
    });
    expect(getExplicitProjectRoutedClientMock).not.toHaveBeenCalled();
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
    expect(routedClientCloseMock).not.toHaveBeenCalled();
  });

  it("refuses to archive when no backups exist yet", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "opened" },
          host_status: "running",
        },
      ],
    });
    const { archiveProject } = await import("./projects");
    await expect(
      archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow(
      "project must have a current backup before it can be archived",
    );

    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("rejects a known stale manual archive before stopping or deleting project data", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "running" },
          host_status: "running",
          last_backup: new Date("2026-06-15T04:32:34.102Z"),
          last_changed: new Date("2026-06-15T04:33:00Z"),
          last_changed_generation: 12,
          last_backup_generation: 11,
        },
      ],
    });
    const { archiveProject } = await import("./projects");
    await expect(
      archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
    ).rejects.toThrow("current backup");
    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("archives a deprovisioned host without reading backups or deleting host data", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "opened" },
          host_status: "deprovisioned",
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

    expect(getExplicitProjectRoutedClientMock).not.toHaveBeenCalled();
    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("archives an off host with existing backups without stopping or deleting host data", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "opened" },
          host_status: "off",
          last_backup: new Date("2026-06-15T04:32:34.102Z"),
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

    expect(getExplicitProjectRoutedClientMock).not.toHaveBeenCalled();
    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("automatic archive never stops and requires its current claim", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          owning_bay_id: "bay-1",
          host_id: "22222222-2222-4222-8222-222222222222",
          backup_repo_id: "33333333-3333-4333-8333-333333333333",
          provisioned: true,
          state: { state: "archiving" },
          host_status: "active",
          last_changed: new Date("2026-06-15T04:00:00.000Z"),
          last_changed_generation: 10,
          last_backup: new Date("2026-06-15T05:00:00.000Z"),
          last_backup_generation: 10,
          archive_lifecycle_job_id: jobId,
        },
      ],
    });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: "11111111-1111-4111-8111-111111111111",
        mode: "automatic",
        job_id: jobId,
        reason: "free-inactive",
        expected_host_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toBeUndefined();

    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).toHaveBeenCalledTimes(1);
  });

  it("automatic archive rejects a busy project without stopping or deleting it", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          owning_bay_id: "bay-1",
          host_id: "22222222-2222-4222-8222-222222222222",
          backup_repo_id: "33333333-3333-4333-8333-333333333333",
          provisioned: true,
          state: { state: "running" },
          host_status: "active",
          last_backup: new Date("2026-06-15T05:00:00.000Z"),
          archive_lifecycle_job_id: jobId,
        },
      ],
    });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: "11111111-1111-4111-8111-111111111111",
        mode: "automatic",
        job_id: jobId,
        reason: "free-inactive",
        expected_host_id: "22222222-2222-4222-8222-222222222222",
      }),
    ).rejects.toThrow("automatic archive project claim is no longer current");

    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });
});
