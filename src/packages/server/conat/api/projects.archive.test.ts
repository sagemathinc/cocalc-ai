export {};

let isAdminMock: jest.Mock;
let poolQueryMock: jest.Mock;
let poolConnectQueryMock: jest.Mock;
let poolConnectReleaseMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let interBayStopMock: jest.Mock;
let deleteProjectDataOnHostMock: jest.Mock;
let deleteProjectDataOnHostAfterBackupMock: jest.Mock;
let releaseProjectDataArchiveFreezeOnHostMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let assertProjectNotRehomingMock: jest.Mock;
let withProjectRehomeWriteFenceMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let routedClientCloseMock: jest.Mock;
let getExplicitProjectRoutedClientMock: jest.Mock;
let assertCanPerformDestructiveStorageActionMock: jest.Mock;
let createProjectArchiveLifecycleJobMock: jest.Mock;
let updateProjectArchiveLifecycleJobMock: jest.Mock;
let getProjectArchiveLifecycleFinalBackupMock: jest.Mock;
let recordProjectArchiveLifecycleFinalBackupMock: jest.Mock;
let clearProjectArchiveLifecycleFinalBackupMock: jest.Mock;
let createBackupMock: jest.Mock;
let waitForDurableLroCompletionMock: jest.Mock;
let listLrosByDedupeMock: jest.Mock;
let attestReleasedLroDedupeSuccessesMock: jest.Mock;
let findUnresolvedManualArchiveJobMock: jest.Mock;
let resumeManualArchiveJobMock: jest.Mock;
let listManualArchiveJobsToRecoverMock: jest.Mock;
let settleManualArchiveJobMock: jest.Mock;
let claimManualArchiveJobForRecoveryMock: jest.Mock;

const AUTOMATIC_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const AUTOMATIC_HOST_ID = "22222222-2222-4222-8222-222222222222";
const AUTOMATIC_JOB_ID = "77777777-7777-4777-8777-777777777777";

const MANUAL_JOB_ID = "77777777-7777-4777-8777-777777777777";
const MANUAL_DEDUPE_KEY = `manual-project-archive-final:${MANUAL_JOB_ID}`;

// A project whose last recorded backup looks newer than its last edit, as
// the client sees it before skipping its own backup.
function manualArchiveRow(overrides: Record<string, any> = {}) {
  return {
    project_id: "proj-1",
    host_id: "host-1",
    backup_repo_id: "repo-1",
    provisioned: true,
    state: { state: "opened" },
    host_status: "running",
    last_edited: new Date("2026-06-15T04:00:00.000Z"),
    last_backup: new Date("2026-06-15T05:00:00.000Z"),
    last_backup_generation: 99,
    ...overrides,
  };
}

function automaticArchiveRow(overrides: Record<string, any> = {}) {
  return {
    project_id: AUTOMATIC_PROJECT_ID,
    owning_bay_id: "bay-1",
    host_id: AUTOMATIC_HOST_ID,
    backup_repo_id: "33333333-3333-4333-8333-333333333333",
    provisioned: true,
    state: { state: "archiving" },
    host_status: "active",
    last_changed: new Date("2026-06-15T04:00:00.000Z"),
    last_changed_generation: 10,
    last_backup: new Date("2026-06-15T05:00:00.000Z"),
    last_backup_generation: 10,
    archive_lifecycle_job_id: AUTOMATIC_JOB_ID,
    ...overrides,
  };
}

jest.mock("@cocalc/backend/conat", () => ({
  __esModule: true,
  conat: jest.fn(() => ({ name: "test-conat-client" })),
}));

const assertOversizedFilesAllowedMock = jest.fn(async (_opts: any) => {});
jest.mock("@cocalc/server/projects/oversized-files", () => ({
  ...jest.requireActual("@cocalc/server/projects/oversized-files"),
  assertOversizedFilesAllowed: (opts: any) =>
    assertOversizedFilesAllowedMock(opts),
}));

jest.mock("@cocalc/server/conat/api/project-backups", () => ({
  __esModule: true,
  createBackup: (...args: any[]) => createBackupMock(...args),
}));

jest.mock("@cocalc/server/lro/wait", () => ({
  __esModule: true,
  waitForDurableLroCompletion: (...args: any[]) =>
    waitForDurableLroCompletionMock(...args),
}));

jest.mock("@cocalc/server/projects/archive-lifecycle-db", () => ({
  __esModule: true,
  createProjectArchiveLifecycleJob: (...args: any[]) =>
    createProjectArchiveLifecycleJobMock(...args),
  updateProjectArchiveLifecycleJob: (...args: any[]) =>
    updateProjectArchiveLifecycleJobMock(...args),
  getProjectArchiveLifecycleFinalBackup: (...args: any[]) =>
    getProjectArchiveLifecycleFinalBackupMock(...args),
  recordProjectArchiveLifecycleFinalBackup: (...args: any[]) =>
    recordProjectArchiveLifecycleFinalBackupMock(...args),
  clearProjectArchiveLifecycleFinalBackup: (...args: any[]) =>
    clearProjectArchiveLifecycleFinalBackupMock(...args),
  findUnresolvedManualArchiveJob: (...args: any[]) =>
    findUnresolvedManualArchiveJobMock(...args),
  resumeManualArchiveJob: (...args: any[]) =>
    resumeManualArchiveJobMock(...args),
  listManualArchiveJobsToRecover: (...args: any[]) =>
    listManualArchiveJobsToRecoverMock(...args),
  settleManualArchiveJob: (...args: any[]) =>
    settleManualArchiveJobMock(...args),
  claimManualArchiveJobForRecovery: (...args: any[]) =>
    claimManualArchiveJobForRecoveryMock(...args),
  MANUAL_ARCHIVE_FREEZE_UNCERTAIN: "manual-archive-freeze-uncertain",
  MANUAL_ARCHIVE_FINALIZE_PENDING: "manual-archive-finalize-pending",
  MANUAL_ARCHIVE_FREEZE_QUARANTINED: "manual-archive-freeze-quarantined",
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

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: jest.fn(() => "bay-1"),
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
  deleteProjectDataOnHostAfterBackup: (...args: any[]) =>
    deleteProjectDataOnHostAfterBackupMock(...args),
  releaseProjectDataArchiveFreezeOnHost: (...args: any[]) =>
    releaseProjectDataArchiveFreezeOnHostMock(...args),
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
  listLrosByDedupe: (...args: any[]) => listLrosByDedupeMock(...args),
  attestReleasedLroDedupeSuccesses: (...args: any[]) =>
    attestReleasedLroDedupeSuccessesMock(...args),
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
  withProjectRehomeWriteFence: (...args: any[]) =>
    withProjectRehomeWriteFenceMock(...args),
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
    deleteProjectDataOnHostAfterBackupMock = jest.fn(async () => undefined);
    releaseProjectDataArchiveFreezeOnHostMock = jest.fn(async () => ({
      status: "released",
    }));
    appendProjectOutboxEventForProjectMock = jest.fn(async () => undefined);
    assertProjectNotRehomingMock = jest.fn(async () => undefined);
    withProjectRehomeWriteFenceMock = jest.fn(
      async ({ fn }) =>
        await fn({
          query: jest.fn(async () => ({ rowCount: 1, rows: [{ exists: 1 }] })),
        }),
    );
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
    getProjectArchiveLifecycleFinalBackupMock = jest.fn(async () => undefined);
    recordProjectArchiveLifecycleFinalBackupMock = jest.fn(
      async () => undefined,
    );
    clearProjectArchiveLifecycleFinalBackupMock = jest.fn(
      async () => undefined,
    );
    listLrosByDedupeMock = jest.fn(async () => []);
    attestReleasedLroDedupeSuccessesMock = jest.fn(async () => []);
    findUnresolvedManualArchiveJobMock = jest.fn(async () => undefined);
    resumeManualArchiveJobMock = jest.fn(async () => true);
    listManualArchiveJobsToRecoverMock = jest.fn(async () => []);
    settleManualArchiveJobMock = jest.fn(async () => true);
    claimManualArchiveJobForRecoveryMock = jest.fn(
      async ({ attempts }) => attempts + 1,
    );
    createBackupMock = jest.fn(async (_input, opts) => {
      opts?.on_lro_create_started?.();
      return {
        op_id: "88888888-8888-4888-8888-888888888888",
        scope_type: "project",
        scope_id: "11111111-1111-4111-8111-111111111111",
      };
    });
    waitForDurableLroCompletionMock = jest.fn(async () => ({
      status: "succeeded",
      result: {
        id: "final-backup-id",
        time: "2026-06-15T05:30:00.000Z",
        generation: 10,
      },
    }));
  });

  it("archives a provisioned project with durable backup metadata", async () => {
    poolQueryMock.mockResolvedValue({
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
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      host_id: "host-1",
      expected_backup_id: "final-backup-id",
      expected_generation: 10,
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
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

  it("refuses before stopping when unconfirmed files would be lost", async () => {
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
    const { OversizedFilesError } = jest.requireActual(
      "@cocalc/server/projects/oversized-files",
    );
    assertOversizedFilesAllowedMock.mockImplementationOnce(async (opts) => {
      expect(opts).toMatchObject({
        project_id: "proj-1",
        action: "archive this project",
        allow_oversized_skip: false,
      });
      throw new OversizedFilesError(opts.action, {
        max_file_bytes: 10_000_000_000,
        count: 1,
        files: [{ path: "huge.img", size: 1_000_000_000_000 }],
      });
    });
    const { archiveProject } = await import("./projects");
    await expect(
      archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
    ).rejects.toThrow("huge.img");
    expect(interBayStopMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("passes the user's confirmation to the oversized file check", async () => {
    poolQueryMock.mockResolvedValue({
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
    await archiveProject({
      account_id: "owner-1",
      project_id: "proj-1",
      allow_oversized_skip: true,
    });
    expect(assertOversizedFilesAllowedMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ allow_oversized_skip: true }),
    );
  });

  it("refuses to archive from an off host when no backups exist yet", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        {
          host_id: "host-1",
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "opened" },
          host_status: "off",
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
      "project must have at least one backup before it can be archived",
    );

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
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
    expect(createBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("checks a caller's deprovisioned-host precondition against the current placement", async () => {
    const row = (host_id: string, host_status: string) => ({
      rows: [
        {
          host_id,
          backup_repo_id: "repo-1",
          provisioned: true,
          state: { state: "opened" },
          host_status,
          last_backup: new Date(),
        },
      ],
    });
    const { archiveProject } = await import("./projects");
    // the project moved to another host, or its host is live again
    for (const current of [
      row("host-2", "deprovisioned"),
      row("host-1", "running"),
    ]) {
      poolQueryMock.mockResolvedValueOnce(current);
      await expect(
        archiveProject({
          account_id: "owner-1",
          project_id: "proj-1",
          require_deprovisioned_host_id: "host-1",
        }),
      ).rejects.toThrow(/host changed or is no longer deprovisioned/);
    }
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );

    // the host became live again between the first check and the commit:
    // the share-locked status check in the fenced transaction refuses
    let hostStatusAtCommit = "running";
    const defaultClientQuery = poolConnectQueryMock.getMockImplementation()!;
    poolConnectQueryMock.mockImplementation(async (sql: string, params) =>
      `${sql}`.includes("FROM project_hosts WHERE id = $1 FOR SHARE")
        ? { rows: [{ status: hostStatusAtCommit }] }
        : defaultClientQuery(sql, params),
    );
    poolQueryMock.mockResolvedValueOnce(row("host-1", "deprovisioned"));
    await expect(
      archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
        require_deprovisioned_host_id: "host-1",
      }),
    ).rejects.toThrow(/host changed or is no longer deprovisioned/);
    expect(poolConnectQueryMock).not.toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );

    // (control) still placed on the deprovisioned host: archived
    hostStatusAtCommit = "deprovisioned";
    poolQueryMock.mockResolvedValueOnce(row("host-1", "deprovisioned"));
    await expect(
      archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
        require_deprovisioned_host_id: "host-1",
      }),
    ).resolves.toBeUndefined();
    // the host row is share-locked, and the commit requires the placement
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("FOR SHARE"),
      ["host-1"],
    );
    const [sql, params] = poolConnectQueryMock.mock.calls.find(([sql]) =>
      `${sql}`.includes("UPDATE projects"),
    )!;
    expect(sql).toContain("$8::uuid IS NULL OR host_id = $8::uuid");
    expect(params[7]).toBe("host-1");
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
    expect(createBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("automatic archive never stops and requires its current claim", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    poolQueryMock.mockResolvedValue({
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
    expect(createBackupMock).toHaveBeenCalledWith(
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        tags: ["automatic-project-archive-final"],
      },
      expect.objectContaining({
        skip_collab_check: true,
        skip_rootfs_portability_check: true,
        replace_oldest_at_limit: true,
        freeze_source: true,
        dedupe_key:
          "automatic-project-archive-final:77777777-7777-4777-8777-777777777777",
      }),
    );
    expect(waitForDurableLroCompletionMock).toHaveBeenCalledTimes(1);
    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
      job_id: jobId,
      backup_id: "final-backup-id",
      backup_generation: 10,
      backup_time: "2026-06-15T05:30:00.000Z",
      expected_previous_backup_id: null,
    });
    expect(
      recordProjectArchiveLifecycleFinalBackupMock.mock.invocationCallOrder[0],
    ).toBeLessThan(
      deleteProjectDataOnHostAfterBackupMock.mock.invocationCallOrder[0],
    );
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
      host_id: "22222222-2222-4222-8222-222222222222",
      expected_backup_id: "final-backup-id",
      expected_generation: 10,
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
  });

  it("releases the final backup freeze when ownership changes during backup", async () => {
    const localOwnership = { bay_id: "bay-1", epoch: 7 };
    resolveProjectBayMock
      .mockResolvedValueOnce(localOwnership)
      .mockResolvedValueOnce(localOwnership)
      .mockResolvedValueOnce(localOwnership)
      .mockResolvedValueOnce({ bay_id: "bay-2", epoch: 8 });
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage, ProjectArchiveStorageError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProjectArchiveStorageError);
    expect(error.message).toContain(
      "automatic archive ownership changed for project",
    );
    expect(error.hostCleanupCompleted).toBe(false);
    expect(error.reopenSafe).toBe(true);
    expect(recordProjectArchiveLifecycleFinalBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
      project_id: AUTOMATIC_PROJECT_ID,
      host_id: AUTOMATIC_HOST_ID,
      expected_generation: 10,
    });
    expect(clearProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
      job_id: AUTOMATIC_JOB_ID,
      backup_id: "final-backup-id",
      backup_generation: 10,
    });
  });

  it("holds the rehome fence across checked host deletion and finalization", async () => {
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });
    let rehomeFenceHeld = false;
    assertProjectNotRehomingMock.mockImplementationOnce(async () => {
      rehomeFenceHeld = true;
    });
    deleteProjectDataOnHostAfterBackupMock.mockImplementationOnce(async () => {
      expect(rehomeFenceHeld).toBe(true);
    });
    poolConnectQueryMock.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") return { rowCount: 0, rows: [] };
      if (sql === "COMMIT" || sql === "ROLLBACK") {
        rehomeFenceHeld = false;
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledTimes(1);
    expect(rehomeFenceHeld).toBe(false);
  });

  it("automatic cleanup locks its claim with the exact host before deleting", async () => {
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });
    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    });
    const lockIndex = poolConnectQueryMock.mock.calls.findIndex(
      ([sql]) =>
        `${sql}`.includes("archive_lifecycle_job_id = $2") &&
        `${sql}`.includes("FOR UPDATE"),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    const [lockSql, lockParams] = poolConnectQueryMock.mock.calls[lockIndex];
    expect(lockSql).toContain("host_id IS NOT DISTINCT FROM $3::uuid");
    expect(lockParams[2]).toBe(AUTOMATIC_HOST_ID);
    expect(
      poolConnectQueryMock.mock.invocationCallOrder[lockIndex],
    ).toBeLessThan(
      deleteProjectDataOnHostAfterBackupMock.mock.invocationCallOrder[0],
    );
  });

  it("does not delete after the fenced ownership claim becomes stale", async () => {
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });
    poolConnectQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT 1") && sql.includes("FOR UPDATE")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const { archiveProjectStorage, ProjectArchiveStorageError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProjectArchiveStorageError);
    expect(error.message).toContain(
      "automatic archive ownership, claim, or placement changed before cleanup",
    );
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
      project_id: AUTOMATIC_PROJECT_ID,
      host_id: AUTOMATIC_HOST_ID,
      expected_generation: 10,
    });
  });

  it("recovers a succeeded final-backup LRO before fresh admission checks", async () => {
    listLrosByDedupeMock.mockResolvedValueOnce([
      {
        op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "failed",
        result: { archive_freeze_recovery: "released" },
      },
      {
        op_id: "88888888-8888-4888-8888-888888888888",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "succeeded",
        result: {
          id: "recovered-final-backup-id",
          time: "2026-06-15T05:30:00.000Z",
          generation: 10,
        },
      },
    ]);
    poolQueryMock.mockResolvedValue({
      rows: [
        automaticArchiveRow({
          host_status: "off",
          last_backup: null,
          last_backup_generation: null,
        }),
      ],
    });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(waitForDurableLroCompletionMock).not.toHaveBeenCalled();
    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
      job_id: AUTOMATIC_JOB_ID,
      backup_id: "recovered-final-backup-id",
      backup_generation: 10,
      backup_time: "2026-06-15T05:30:00.000Z",
      expected_previous_backup_id: null,
    });
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
  });

  it("does not reuse a succeeded final-backup LRO after its freeze was released", async () => {
    listLrosByDedupeMock.mockResolvedValueOnce([
      {
        op_id: "88888888-8888-4888-8888-888888888888",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "succeeded",
        result: {
          id: "released-final-backup-id",
          time: "2026-06-15T05:30:00.000Z",
          generation: 10,
          archive_freeze_recovery: "released",
        },
      },
    ]);
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({ backup_id: "final-backup-id" }),
    );
  });

  it("resumes an active final-backup LRO instead of creating another", async () => {
    listLrosByDedupeMock.mockResolvedValueOnce([
      {
        op_id: "99999999-9999-4999-8999-999999999999",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "running",
      },
    ]);
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(waitForDurableLroCompletionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "99999999-9999-4999-8999-999999999999",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
      }),
    );
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
      project_id: AUTOMATIC_PROJECT_ID,
      host_id: AUTOMATIC_HOST_ID,
      expected_backup_id: "final-backup-id",
      expected_generation: 10,
    });
  });

  it.each([
    ["an active final backup", true],
    ["a new final backup", false],
  ])(
    "stops waiting for %s after the bounded wait, releasing nothing and queuing the job",
    async (_, active) => {
      if (active) {
        listLrosByDedupeMock.mockResolvedValueOnce([
          {
            op_id: "99999999-9999-4999-8999-999999999999",
            scope_type: "project",
            scope_id: AUTOMATIC_PROJECT_ID,
            status: "running",
          },
        ]);
      }
      poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });
      waitForDurableLroCompletionMock.mockRejectedValueOnce(
        new Error("timeout waiting for lro completion"),
      );

      const { archiveProjectStorage, FinalArchiveBackupPendingError } =
        await import("@cocalc/server/projects/archive");
      const attempt = archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
        final_backup_wait_ms: 60_000,
      });
      await expect(attempt).rejects.toBeInstanceOf(
        FinalArchiveBackupPendingError,
      );
      expect(waitForDurableLroCompletionMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeout_ms: 60_000 }),
      );
      // the running backup owns its freeze: nothing is released or deleted
      expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updateProjectArchiveLifecycleJobMock).toHaveBeenCalledWith({
        job_id: AUTOMATIC_JOB_ID,
        status: "queued",
      });
      expect(updateProjectArchiveLifecycleJobMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    },
  );

  it("(control) an unbounded wait that times out still fails the job", async () => {
    listLrosByDedupeMock.mockResolvedValueOnce([
      {
        op_id: "99999999-9999-4999-8999-999999999999",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "running",
      },
    ]);
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });
    waitForDurableLroCompletionMock.mockRejectedValueOnce(
      new Error("timeout waiting for lro completion"),
    );
    const { archiveProjectStorage, FinalArchiveBackupPendingError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);
    expect(error).not.toBeInstanceOf(FinalArchiveBackupPendingError);
    expect(updateProjectArchiveLifecycleJobMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("does not recover an older success across a newer uncertain attempt", async () => {
    listLrosByDedupeMock.mockResolvedValueOnce([
      {
        op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "failed",
        result: { archive_freeze_recovery: "uncertain" },
      },
      {
        op_id: "88888888-8888-4888-8888-888888888888",
        scope_type: "project",
        scope_id: AUTOMATIC_PROJECT_ID,
        status: "succeeded",
        result: {
          id: "possibly-pruned-backup-id",
          time: "2026-06-15T05:15:00.000Z",
          generation: 10,
        },
      },
    ]);
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage } =
      await import("@cocalc/server/projects/archive");
    await expect(
      archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }),
    ).resolves.toBeUndefined();

    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith(
      expect.objectContaining({ backup_id: "final-backup-id" }),
    );
  });

  it.each([
    ["not started", { archive_freeze_recovery: "not-started" }],
    ["released", { archive_freeze_recovery: "released" }],
  ])(
    "does not let a new %s failure override older uncertain freeze history",
    async (_case, result) => {
      listLrosByDedupeMock.mockResolvedValueOnce([
        {
          op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          scope_type: "project",
          scope_id: AUTOMATIC_PROJECT_ID,
          status: "failed",
          result: { archive_freeze_recovery: "uncertain" },
        },
      ]);
      waitForDurableLroCompletionMock.mockResolvedValueOnce({
        status: "failed",
        error: "new retry failed safely",
        result,
      });
      poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

      const { archiveProjectStorage, ProjectArchiveStorageError } =
        await import("@cocalc/server/projects/archive");
      const error = await archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(ProjectArchiveStorageError);
      expect(error.reopenSafe).toBe(false);
    },
  );

  it.each([
    ["uncertain", { archive_freeze_recovery: "uncertain" }, false],
    ["released", { archive_freeze_recovery: "released" }, true],
  ])(
    "treats a pre-admission failure after %s LRO history safely",
    async (_case, result, reopenSafe) => {
      listLrosByDedupeMock.mockResolvedValueOnce([
        {
          op_id: "88888888-8888-4888-8888-888888888888",
          scope_type: "project",
          scope_id: AUTOMATIC_PROJECT_ID,
          status: "failed",
          result,
        },
      ]);
      createBackupMock.mockRejectedValueOnce(
        new Error("managed backup egress blocked before LRO creation"),
      );
      poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

      const { archiveProjectStorage, ProjectArchiveStorageError } =
        await import("@cocalc/server/projects/archive");
      const error = await archiveProjectStorage({
        project_id: AUTOMATIC_PROJECT_ID,
        mode: "automatic",
        job_id: AUTOMATIC_JOB_ID,
        reason: "free-inactive",
        expected_host_id: AUTOMATIC_HOST_ID,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(ProjectArchiveStorageError);
      expect(error.message).toContain(
        "managed backup egress blocked before LRO creation",
      );
      expect(error.reopenSafe).toBe(reopenSafe);
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed when final-backup LRO history cannot be read", async () => {
    listLrosByDedupeMock.mockRejectedValueOnce(
      new Error("LRO database unavailable"),
    );
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage, ProjectArchiveStorageError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProjectArchiveStorageError);
    expect(error.message).toContain("LRO database unavailable");
    expect(error.reopenSafe).toBe(false);
    expect(createBackupMock).not.toHaveBeenCalled();
  });

  it("fails closed when LRO creation starts but its result is lost", async () => {
    createBackupMock.mockImplementationOnce(async (_input, opts) => {
      opts?.on_lro_create_started?.();
      throw new Error("backup LRO commit response lost");
    });
    poolQueryMock.mockResolvedValue({ rows: [automaticArchiveRow()] });

    const { archiveProjectStorage, ProjectArchiveStorageError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProjectArchiveStorageError);
    expect(error.message).toContain("backup LRO commit response lost");
    expect(error.reopenSafe).toBe(false);
  });

  it("retries cleanup with a host-local marker after a project move", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    getProjectArchiveLifecycleFinalBackupMock.mockResolvedValueOnce({
      id: "final-backup-id",
      generation: 10,
      time: "2026-06-15T05:30:00.000Z",
    });
    poolQueryMock.mockResolvedValue({
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
          // This generation came from the source host and is not comparable
          // with the persisted final backup's destination-host generation.
          last_changed_generation: 818669,
          last_backup: new Date("2026-06-15T05:00:00.000Z"),
          last_backup_generation: 818669,
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

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(waitForDurableLroCompletionMock).not.toHaveBeenCalled();
    expect(recordProjectArchiveLifecycleFinalBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledTimes(1);
  });

  it("finalizes from a persisted final backup when the host is unavailable", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    getProjectArchiveLifecycleFinalBackupMock.mockResolvedValueOnce({
      id: "final-backup-id",
      generation: 10,
      time: "2026-06-15T05:30:00.000Z",
    });
    poolQueryMock.mockResolvedValue({
      rows: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          owning_bay_id: "bay-1",
          host_id: "22222222-2222-4222-8222-222222222222",
          backup_repo_id: "33333333-3333-4333-8333-333333333333",
          provisioned: true,
          state: { state: "archiving" },
          host_status: "off",
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

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    expect(poolConnectQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE projects"),
      expect.anything(),
    );
  });

  it("finalizes an already deprovisioned automatic archive without a host", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    poolQueryMock.mockResolvedValue({
      rows: [
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          owning_bay_id: "bay-1",
          host_id: "22222222-2222-4222-8222-222222222222",
          backup_repo_id: "33333333-3333-4333-8333-333333333333",
          provisioned: false,
          state: { state: "archiving" },
          host_status: "deprovisioned",
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
    ).resolves.toBeUndefined();

    expect(createBackupMock).not.toHaveBeenCalled();
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", true, false, false, false],
    ["released", false, true, true, false],
    ["already-writable", false, true, true, false],
    ["released with marker-clear failure", false, false, true, true],
  ])(
    "handles a %s volume after a lost deletion response",
    async (
      status,
      hostCleanupCompleted,
      reopenSafe,
      markerClearCalled,
      markerClearFails,
    ) => {
      const jobId = "77777777-7777-4777-8777-777777777777";
      const row = {
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
      };
      poolQueryMock
        .mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rows: [row] });
      deleteProjectDataOnHostAfterBackupMock.mockRejectedValueOnce(
        new Error("host response lost"),
      );
      releaseProjectDataArchiveFreezeOnHostMock.mockResolvedValueOnce({
        status: status.startsWith("released") ? "released" : status,
      });
      if (markerClearFails) {
        clearProjectArchiveLifecycleFinalBackupMock.mockRejectedValueOnce(
          new Error("marker clear failed"),
        );
      }

      const { archiveProjectStorage, ProjectArchiveStorageError } =
        await import("@cocalc/server/projects/archive");
      const error = await archiveProjectStorage({
        project_id: row.project_id,
        mode: "automatic",
        job_id: jobId,
        reason: "free-inactive",
        expected_host_id: row.host_id,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(ProjectArchiveStorageError);
      expect(error.hostCleanupCompleted).toBe(hostCleanupCompleted);
      expect(error.reopenSafe).toBe(reopenSafe);
      expect(clearProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledTimes(
        markerClearCalled ? 1 : 0,
      );
    },
  );

  it("does not reopen after release while another LRO remains uncertain", async () => {
    const row = automaticArchiveRow();
    poolQueryMock.mockResolvedValue({ rows: [row] });
    deleteProjectDataOnHostAfterBackupMock.mockRejectedValueOnce(
      new Error("host response lost"),
    );
    releaseProjectDataArchiveFreezeOnHostMock.mockResolvedValueOnce({
      status: "released",
    });
    attestReleasedLroDedupeSuccessesMock.mockResolvedValueOnce([
      {
        op_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "failed",
        result: { archive_freeze_recovery: "uncertain" },
      },
      {
        op_id: "88888888-8888-4888-8888-888888888888",
        status: "succeeded",
        result: { id: "final-backup-id", generation: 10 },
      },
    ]);

    const { archiveProjectStorage, ProjectArchiveStorageError } =
      await import("@cocalc/server/projects/archive");
    const error = await archiveProjectStorage({
      project_id: AUTOMATIC_PROJECT_ID,
      mode: "automatic",
      job_id: AUTOMATIC_JOB_ID,
      reason: "free-inactive",
      expected_host_id: AUTOMATIC_HOST_ID,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(ProjectArchiveStorageError);
    expect(error.reopenSafe).toBe(false);
    expect(attestReleasedLroDedupeSuccessesMock).toHaveBeenCalledWith({
      scope_type: "project",
      scope_id: AUTOMATIC_PROJECT_ID,
      dedupe_key: `automatic-project-archive-final:${AUTOMATIC_JOB_ID}`,
      expected_result_id: "final-backup-id",
      expected_generation: 10,
    });
    expect(clearProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledTimes(
      1,
    );
  });

  it("automatic archive replaces an invalid final-backup marker", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    getProjectArchiveLifecycleFinalBackupMock.mockResolvedValueOnce({
      id: "stale-final-backup-id",
      generation: 0,
      time: "2026-06-15T03:30:00.000Z",
    });
    poolQueryMock.mockResolvedValue({
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

    expect(createBackupMock).toHaveBeenCalledTimes(1);
    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
      job_id: jobId,
      backup_id: "final-backup-id",
      backup_generation: 10,
      backup_time: "2026-06-15T05:30:00.000Z",
      expected_previous_backup_id: "stale-final-backup-id",
    });
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["not started", { archive_freeze_recovery: "not-started" }, true],
    ["confirmed released", { archive_freeze_recovery: "released" }, true],
    ["uncertain", { archive_freeze_recovery: "uncertain" }, false],
  ])(
    "automatic archive preserves host data after a %s final-backup failure",
    async (_case, result, reopenSafe) => {
      const jobId = "77777777-7777-4777-8777-777777777777";
      poolQueryMock.mockResolvedValue({
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
      waitForDurableLroCompletionMock.mockResolvedValueOnce({
        status: "failed",
        error: "R2 unavailable",
        result,
      });

      const { archiveProjectStorage, ProjectArchiveStorageError } =
        await import("@cocalc/server/projects/archive");
      const error = await archiveProjectStorage({
        project_id: "11111111-1111-4111-8111-111111111111",
        mode: "automatic",
        job_id: jobId,
        reason: "free-inactive",
        expected_host_id: "22222222-2222-4222-8222-222222222222",
      }).catch((err) => err);

      expect(error).toBeInstanceOf(ProjectArchiveStorageError);
      expect(error.message).toContain(
        "final automatic archive backup failed: R2 unavailable",
      );
      expect(error.hostCleanupCompleted).toBe(false);
      expect(error.reopenSafe).toBe(reopenSafe);
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
    },
  );

  it("uses the host-local final backup generation after a project move", async () => {
    const jobId = "77777777-7777-4777-8777-777777777777";
    const row = {
      project_id: "11111111-1111-4111-8111-111111111111",
      owning_bay_id: "bay-1",
      host_id: "22222222-2222-4222-8222-222222222222",
      backup_repo_id: "33333333-3333-4333-8333-333333333333",
      provisioned: true,
      state: { state: "archiving" },
      host_status: "active",
      last_changed: new Date("2026-06-15T04:00:00.000Z"),
      // Project generations are retained monotonically by the control plane,
      // so this can be from a different Btrfs filesystem before a host move.
      last_changed_generation: 818669,
      last_backup: new Date("2026-06-15T05:00:00.000Z"),
      last_backup_generation: 818669,
      archive_lifecycle_job_id: jobId,
    };
    poolQueryMock
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({
        rows: [
          {
            ...row,
            last_changed: new Date("2026-06-15T06:00:00.000Z"),
            last_changed_generation: 818669,
            last_backup: new Date("2026-06-15T06:30:00.000Z"),
            last_backup_generation: 818669,
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

    expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
      job_id: jobId,
      backup_id: "final-backup-id",
      backup_generation: 10,
      backup_time: "2026-06-15T05:30:00.000Z",
      expected_previous_backup_id: null,
    });
    expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
      project_id: "11111111-1111-4111-8111-111111111111",
      host_id: "22222222-2222-4222-8222-222222222222",
      expected_backup_id: "final-backup-id",
      expected_generation: 10,
    });
    expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
    expect(clearProjectArchiveLifecycleFinalBackupMock).not.toHaveBeenCalled();
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
    expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
  });

  describe("manual archive final backup", () => {
    function updatedProjects() {
      return poolConnectQueryMock.mock.calls.filter(([sql]) =>
        `${sql}`.includes("UPDATE projects"),
      );
    }

    it("deletes only against the frozen final backup it makes, even when an earlier backup looks current", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).resolves.toBeUndefined();

      expect(createBackupMock).toHaveBeenCalledTimes(1);
      const [input, opts] = createBackupMock.mock.calls[0];
      expect(input).toEqual({
        project_id: "proj-1",
        tags: [
          "automatic-project-archive-final",
          "manual-project-archive-final",
        ],
      });
      expect(opts).toEqual(
        expect.objectContaining({
          freeze_source: true,
          replace_oldest_at_limit: false,
          dedupe_key: MANUAL_DEDUPE_KEY,
        }),
      );
      expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledTimes(1);
      expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_backup_id: "final-backup-id",
        expected_generation: 10,
      });
      expect(
        waitForDurableLroCompletionMock.mock.invocationCallOrder[0],
      ).toBeLessThan(
        deleteProjectDataOnHostAfterBackupMock.mock.invocationCallOrder[0],
      );
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      // recorded on the job before the host data is deleted
      expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith(
        {
          job_id: MANUAL_JOB_ID,
          backup_id: "final-backup-id",
          backup_generation: 10,
          backup_time: "2026-06-15T05:30:00.000Z",
          expected_previous_backup_id: null,
        },
      );
      expect(
        recordProjectArchiveLifecycleFinalBackupMock.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        deleteProjectDataOnHostAfterBackupMock.mock.invocationCallOrder[0],
      );
      expect(updatedProjects()).toHaveLength(1);
    });

    it("tags its final backup so automatic retention never replaces it", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      const { archiveProject } = await import("./projects");
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      const { tags } = createBackupMock.mock.calls[0][0];
      // the host's retention replaces only untagged or cocalc-automatic
      // snapshots (file-server/btrfs/subvolume-rustic.ts)
      expect(tags).toContain("automatic-project-archive-final");
      expect(tags).not.toContain("cocalc-automatic");
      expect(tags.length).toBeGreaterThan(0);
    });

    it("(control) each manual archive job gets its own final backup key", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      createProjectArchiveLifecycleJobMock
        .mockResolvedValueOnce({ id: "job-a" })
        .mockResolvedValueOnce({ id: "job-b" });
      const { archiveProject } = await import("./projects");
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      expect(
        createBackupMock.mock.calls.map(([, opts]) => opts.dedupe_key),
      ).toEqual([
        "manual-project-archive-final:job-a",
        "manual-project-archive-final:job-b",
      ]);
    });

    it("refuses and keeps the data when its final backup fails", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      waitForDurableLroCompletionMock.mockResolvedValue({
        status: "failed",
        error: "R2 unavailable",
      });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("R2 unavailable");

      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
      expect(updateProjectArchiveLifecycleJobMock).toHaveBeenCalledWith(
        expect.objectContaining({ job_id: MANUAL_JOB_ID, status: "failed" }),
      );
    });

    it("refuses at the backup limit without replacing an existing backup", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      waitForDurableLroCompletionMock.mockResolvedValue({
        status: "failed",
        error: "backup limit reached (507)",
      });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("backup limit reached");

      // the host replaces older backups only when asked to
      expect(createBackupMock).toHaveBeenCalledTimes(1);
      expect(createBackupMock.mock.calls[0][1].replace_oldest_at_limit).toBe(
        false,
      );
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
    });

    it("ignores anything the client says about its own backup", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      const { archiveProject } = await import("./projects");
      await archiveProject({
        account_id: "owner-1",
        project_id: "proj-1",
        // not part of the API; a client cannot vouch for a backup
        backup_id: "client-backup",
        backup_time: new Date("2026-06-15T06:00:00.000Z"),
        expected_backup_id: "client-backup",
        expected_generation: 99,
        reused: true,
      } as any);
      expect(createBackupMock).toHaveBeenCalledTimes(1);
      expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_backup_id: "final-backup-id",
        expected_generation: 10,
      });
    });

    it("refuses when its final backup reports no filesystem generation", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      waitForDurableLroCompletionMock.mockResolvedValue({
        status: "succeeded",
        result: { id: "final-backup-id", time: "2026-06-15T05:30:00.000Z" },
      });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("without a filesystem generation");

      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
    });

    it("releases its freeze and keeps the data when the host's checked delete refuses", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      // e.g. the final backup was forgotten before the delete
      deleteProjectDataOnHostAfterBackupMock.mockRejectedValue(
        new Error("archive backup snapshot final-backup-id not found"),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("not found");

      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
      expect(poolConnectQueryMock).toHaveBeenCalledWith("ROLLBACK");
      expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_generation: 10,
      });
      expect(attestReleasedLroDedupeSuccessesMock).toHaveBeenCalledWith({
        scope_type: "project",
        scope_id: "proj-1",
        dedupe_key: MANUAL_DEDUPE_KEY,
        expected_result_id: "final-backup-id",
        expected_generation: 10,
      });
      expect(clearProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith({
        job_id: MANUAL_JOB_ID,
        backup_id: "final-backup-id",
        backup_generation: 10,
      });
    });

    it("refuses when the project's host changes during its final backup", async () => {
      for (const moved of [
        manualArchiveRow({ host_id: "host-2" }),
        manualArchiveRow({ host_status: "off" }),
      ]) {
        releaseProjectDataArchiveFreezeOnHostMock.mockClear();
        poolQueryMock
          .mockResolvedValueOnce({ rows: [manualArchiveRow()] })
          .mockResolvedValueOnce({ rows: [manualArchiveRow()] })
          .mockResolvedValue({ rows: [moved] });
        const { archiveProject } = await import("./projects");
        await expect(
          archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
        ).rejects.toThrow("host changed during the archive");
        // the freeze is released on the host whose volume was frozen
        expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
          project_id: "proj-1",
          host_id: "host-1",
          expected_generation: 10,
        });
      }
      expect(createBackupMock).toHaveBeenCalledTimes(2);
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
    });

    it("deletes nothing when ownership moves before the fenced cleanup", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      // A rehome completed after the final backup and the placement checks:
      // under the rehome fence the project row is no longer this bay's.
      const defaultClientQuery = poolConnectQueryMock.getMockImplementation()!;
      poolConnectQueryMock.mockImplementation(async (sql: string, params) =>
        `${sql}`.includes("FOR UPDATE") && `${sql}`.includes("owning_bay_id")
          ? { rowCount: 0, rows: [] }
          : defaultClientQuery(sql, params),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("owner or host changed during the archive");

      const [lockSql, lockParams] = poolConnectQueryMock.mock.calls.find(
        ([sql]) => `${sql}`.includes("FOR UPDATE"),
      )!;
      expect(lockSql).toContain("host_id IS NOT DISTINCT FROM $2::uuid");
      expect(lockParams).toEqual(["proj-1", "host-1", "bay-1"]);
      expect(
        poolConnectQueryMock.mock.invocationCallOrder[
          poolConnectQueryMock.mock.calls.findIndex(([sql]) =>
            `${sql}`.includes("FOR UPDATE"),
          )
        ],
      ).toBeGreaterThan(
        assertProjectNotRehomingMock.mock.invocationCallOrder[0],
      );
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(updatedProjects()).toHaveLength(0);
      expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_generation: 10,
      });
    });

    it("finalizes only while the owning bay and host are unchanged", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      const { archiveProject } = await import("./projects");
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      const [sql, params] = updatedProjects()[0];
      expect(sql).toContain("host_id IS NOT DISTINCT FROM $7::uuid");
      expect(sql).toContain(
        "COALESCE(NULLIF(BTRIM(owning_bay_id), ''), $9) = $9",
      );
      expect(params[6]).toBe("host-1");
      expect(params[8]).toBe("bay-1");
    });

    it("never deletes without a final backup when no earlier backup exists", async () => {
      poolQueryMock.mockResolvedValue({
        rows: [
          manualArchiveRow({ last_backup: null, last_backup_generation: null }),
        ],
      });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).resolves.toBeUndefined();
      expect(createBackupMock).toHaveBeenCalledTimes(1);
      expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          expected_backup_id: "final-backup-id",
          expected_generation: 10,
        }),
      );
      expect(deleteProjectDataOnHostMock).not.toHaveBeenCalled();
    });
  });

  describe("manual archive freeze recovery", () => {
    const succeeded = (generation = 10, id = "final-backup-id") => ({
      op_id: `lro-${generation}`,
      status: "succeeded",
      result: { id, generation, time: "2026-06-15T05:30:00.000Z" },
    });
    const failedJob = (overrides: Record<string, any> = {}) => ({
      id: MANUAL_JOB_ID,
      project_id: "proj-1",
      host_id: "host-1",
      status: "failed",
      failure_category: "manual-archive-freeze-uncertain",
      final_backup_id: null,
      backup_generation: null,
      attempts: 3,
      recovery_errors: 0,
      stale: false,
      ...overrides,
    });
    function updatedProjects() {
      return poolConnectQueryMock.mock.calls.filter(([sql]) =>
        `${sql}`.includes("UPDATE projects"),
      );
    }
    function jobStatuses() {
      return updateProjectArchiveLifecycleJobMock.mock.calls.map(
        ([opts]) => `${opts.status}:${opts.failure_category ?? ""}`,
      );
    }

    it("marks the job freeze-uncertain when the final backup's result is lost", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      waitForDurableLroCompletionMock.mockRejectedValue(
        new Error("lost the backup result"),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("lost the backup result");
      expect(jobStatuses()).toEqual(["failed:manual-archive-freeze-uncertain"]);
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
      expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
    });

    it("a retry after a lost result resumes the same job and reuses its durable backup", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      findUnresolvedManualArchiveJobMock.mockResolvedValue(failedJob());
      // the first attempt's backup succeeded durably
      listLrosByDedupeMock.mockResolvedValue([succeeded()]);
      const { archiveProject } = await import("./projects");
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });

      expect(resumeManualArchiveJobMock).toHaveBeenCalledWith(MANUAL_JOB_ID);
      expect(createProjectArchiveLifecycleJobMock).not.toHaveBeenCalled();
      expect(listLrosByDedupeMock).toHaveBeenCalledWith({
        scope_type: "project",
        scope_id: "proj-1",
        dedupe_key: MANUAL_DEDUPE_KEY,
      });
      // no second backup, no new key
      expect(createBackupMock).not.toHaveBeenCalled();
      expect(recordProjectArchiveLifecycleFinalBackupMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: MANUAL_JOB_ID,
          backup_id: "final-backup-id",
          backup_generation: 10,
        }),
      );
      expect(deleteProjectDataOnHostAfterBackupMock).toHaveBeenCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_backup_id: "final-backup-id",
        expected_generation: 10,
      });
      expect(jobStatuses()).toEqual(["completed:"]);
    });

    it("refuses, never resuming, a previous archive that maintenance quarantined", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      findUnresolvedManualArchiveJobMock.mockResolvedValue(
        failedJob({ failure_category: "manual-archive-freeze-quarantined" }),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("needs an engineer");
      expect(resumeManualArchiveJobMock).not.toHaveBeenCalled();
      expect(createProjectArchiveLifecycleJobMock).not.toHaveBeenCalled();
      expect(createBackupMock).not.toHaveBeenCalled();
      expect(deleteProjectDataOnHostAfterBackupMock).not.toHaveBeenCalled();
    });

    it("refuses while another manual archive of the project is running", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      findUnresolvedManualArchiveJobMock.mockResolvedValue(
        failedJob({ status: "running", stale: false }),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("already running");
      expect(createProjectArchiveLifecycleJobMock).not.toHaveBeenCalled();
      expect(createBackupMock).not.toHaveBeenCalled();
    });

    it("refuses to start a new backup while an old freeze is held on another host", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      findUnresolvedManualArchiveJobMock.mockResolvedValue(
        failedJob({ host_id: "host-0" }),
      );
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("still being recovered");
      expect(resumeManualArchiveJobMock).not.toHaveBeenCalled();
      expect(createProjectArchiveLifecycleJobMock).not.toHaveBeenCalled();
      expect(createBackupMock).not.toHaveBeenCalled();
    });

    it("after a delete whose archive transaction failed, a retry finishes from the same marker", async () => {
      poolQueryMock.mockResolvedValue({ rows: [manualArchiveRow()] });
      const defaultClientQuery = poolConnectQueryMock.getMockImplementation()!;
      let failUpdate = true;
      poolConnectQueryMock.mockImplementation(async (sql: string, params) => {
        if (failUpdate && `${sql}`.includes("UPDATE projects")) {
          throw new Error("database went away");
        }
        return defaultClientQuery(sql, params);
      });
      // the checked delete succeeds; afterwards the volume is gone
      releaseProjectDataArchiveFreezeOnHostMock.mockResolvedValue({
        status: "absent",
      });
      const { archiveProject } = await import("./projects");
      await expect(
        archiveProject({ account_id: "owner-1", project_id: "proj-1" }),
      ).rejects.toThrow("database went away");
      expect(jobStatuses()).toEqual(["failed:manual-archive-finalize-pending"]);
      expect(createBackupMock).toHaveBeenCalledTimes(1);

      // retry: same job, recorded marker, no second backup
      failUpdate = false;
      updateProjectArchiveLifecycleJobMock.mockClear();
      findUnresolvedManualArchiveJobMock.mockResolvedValue(
        failedJob({
          failure_category: "manual-archive-finalize-pending",
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        }),
      );
      getProjectArchiveLifecycleFinalBackupMock.mockResolvedValue({
        id: "final-backup-id",
        generation: 10,
        time: "2026-06-15T05:30:00.000Z",
      });
      deleteProjectDataOnHostAfterBackupMock.mockRejectedValue(
        new Error("volume not found"),
      );
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      expect(createBackupMock).toHaveBeenCalledTimes(1);
      expect(createProjectArchiveLifecycleJobMock).toHaveBeenCalledTimes(1);
      expect(
        releaseProjectDataArchiveFreezeOnHostMock,
      ).toHaveBeenLastCalledWith({
        project_id: "proj-1",
        host_id: "host-1",
        expected_generation: 10,
      });
      expect(jobStatuses()).toEqual(["completed:"]);
      expect(updatedProjects().length).toBeGreaterThan(0);
    });

    it("an archive whose commit landed but whose caller never heard back is reconciled, not reopened", async () => {
      poolQueryMock.mockResolvedValue({
        rows: [
          manualArchiveRow({
            state: { state: "archived" },
            provisioned: false,
          }),
        ],
      });
      findUnresolvedManualArchiveJobMock.mockResolvedValue(
        failedJob({
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        }),
      );
      const { archiveProject } = await import("./projects");
      await archiveProject({ account_id: "owner-1", project_id: "proj-1" });
      expect(settleManualArchiveJobMock).toHaveBeenCalledWith({
        job_id: MANUAL_JOB_ID,
        status: "completed",
        failure_category: null,
        clear_final_backup: false,
      });
      expect(releaseProjectDataArchiveFreezeOnHostMock).not.toHaveBeenCalled();
      expect(createBackupMock).not.toHaveBeenCalled();
    });

    describe("maintenance", () => {
      async function recover(
        job: Record<string, any>,
        row = manualArchiveRow(),
      ) {
        listManualArchiveJobsToRecoverMock.mockResolvedValue([failedJob(job)]);
        poolQueryMock.mockResolvedValue({ rows: [row] });
        const { recoverManualArchiveFreezes } =
          await import("@cocalc/server/projects/archive");
        const [result] = await recoverManualArchiveFreezes();
        return result;
      }
      const settled = () =>
        settleManualArchiveJobMock.mock.calls.map(([o]) => o);

      it("releases a stuck manual freeze at the generation recorded on the job", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        const result = await recover({
          failure_category: "stuck-manual-archive",
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        });
        expect(result.outcome).toBe("released");
        expect(listLrosByDedupeMock).toHaveBeenCalledWith({
          scope_type: "project",
          scope_id: "proj-1",
          dedupe_key: MANUAL_DEDUPE_KEY,
        });
        expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
          project_id: "proj-1",
          host_id: "host-1",
          expected_generation: 10,
        });
        expect(attestReleasedLroDedupeSuccessesMock).toHaveBeenCalledWith({
          scope_type: "project",
          scope_id: "proj-1",
          dedupe_key: MANUAL_DEDUPE_KEY,
          expected_result_id: "final-backup-id",
          expected_generation: 10,
        });
        expect(claimManualArchiveJobForRecoveryMock).toHaveBeenCalledWith({
          job_id: MANUAL_JOB_ID,
          attempts: 3,
        });
        expect(
          claimManualArchiveJobForRecoveryMock.mock.invocationCallOrder[0],
        ).toBeLessThan(
          releaseProjectDataArchiveFreezeOnHostMock.mock.invocationCallOrder[0],
        );
        // fenced on the claim
        expect(settled()).toEqual([
          {
            job_id: MANUAL_JOB_ID,
            claimed_attempts: 4,
            status: "failed",
            failure_category: "manual-archive-freeze-released",
            clear_final_backup: true,
          },
        ]);
        expect(updatedProjects()).toHaveLength(0);
      });

      it("releases at the durable backup's generation when the marker was never recorded", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(12, "backup-12")]);
        const result = await recover({});
        expect(result.outcome).toBe("released");
        expect(releaseProjectDataArchiveFreezeOnHostMock).toHaveBeenCalledWith({
          project_id: "proj-1",
          host_id: "host-1",
          expected_generation: 12,
        });
        expect(attestReleasedLroDedupeSuccessesMock).toHaveBeenCalledWith(
          expect.objectContaining({
            expected_result_id: "backup-12",
            expected_generation: 12,
          }),
        );
      });

      it("finishes the archive when the checked delete already completed (hub exit before commit)", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        releaseProjectDataArchiveFreezeOnHostMock.mockResolvedValue({
          status: "absent",
        });
        const result = await recover({
          failure_category: "stuck-manual-archive",
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        });
        expect(result.outcome).toBe("finalized");
        expect(updatedProjects()).toHaveLength(1);
        expect(attestReleasedLroDedupeSuccessesMock).not.toHaveBeenCalled();
        expect(settled()).toEqual([
          {
            job_id: MANUAL_JOB_ID,
            claimed_attempts: 4,
            status: "completed",
            failure_category: null,
            clear_final_backup: false,
          },
        ]);
      });

      it("never releases or reopens a project that is archived already", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        const result = await recover(
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          manualArchiveRow({
            state: { state: "archived" },
            provisioned: false,
          }),
        );
        expect(result.outcome).toBe("reconciled");
        expect(
          releaseProjectDataArchiveFreezeOnHostMock,
        ).not.toHaveBeenCalled();
        expect(updatedProjects()).toHaveLength(0);
      });

      it.each([
        [
          "the recorded and durable generations differ",
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          () => listLrosByDedupeMock.mockResolvedValue([succeeded(11)]),
        ],
        [
          "the host refuses the release",
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          () => {
            listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
            releaseProjectDataArchiveFreezeOnHostMock.mockRejectedValue(
              new Error(
                "refusing to release archive freeze at generation 11; expected 10",
              ),
            );
          },
        ],
        [
          "an attempt's outcome is uncertain",
          {},
          () =>
            listLrosByDedupeMock.mockResolvedValue([
              {
                op_id: "lro-u",
                status: "failed",
                result: { archive_freeze_recovery: "uncertain" },
              },
            ]),
        ],
        [
          "the recorded backup id differs from the durable one at the same generation",
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          () =>
            listLrosByDedupeMock.mockResolvedValue([
              succeeded(10, "other-backup"),
            ]),
        ],
        [
          "no durable final backup matches the recorded one",
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          () => listLrosByDedupeMock.mockResolvedValue([]),
        ],
        [
          "the host answers with an unknown status",
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          () => {
            listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
            releaseProjectDataArchiveFreezeOnHostMock.mockResolvedValue({
              status: "frozen-elsewhere",
            });
          },
        ],
        [
          "more than one durable backup is unreleased",
          {},
          () =>
            listLrosByDedupeMock.mockResolvedValue([
              succeeded(10),
              succeeded(11, "backup-11"),
            ]),
        ],
      ])("quarantines when %s", async (label, job, arrange) => {
        arrange();
        const result = await recover(job);
        expect(result.outcome).toBe("quarantined");
        if (!/host/.test(label)) {
          // proven contradictions are quarantined before any host release
          expect(
            releaseProjectDataArchiveFreezeOnHostMock,
          ).not.toHaveBeenCalled();
        }
        expect(updatedProjects()).toHaveLength(0);
        expect(attestReleasedLroDedupeSuccessesMock).not.toHaveBeenCalled();
        expect(settled()).toEqual([
          expect.objectContaining({
            job_id: MANUAL_JOB_ID,
            status: "failed",
            failure_category: "manual-archive-freeze-quarantined",
            clear_final_backup: false,
            claimed_attempts: 4,
          }),
        ]);
      });

      it("does nothing with a job it could not claim (a user's archive resumed it)", async () => {
        claimManualArchiveJobForRecoveryMock.mockResolvedValue(undefined);
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        const result = await recover({
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        });
        expect(result.outcome).toBe("skipped");
        expect(
          releaseProjectDataArchiveFreezeOnHostMock,
        ).not.toHaveBeenCalled();
        expect(settleManualArchiveJobMock).not.toHaveBeenCalled();
      });

      it("retries a transient host failure instead of quarantining it", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        releaseProjectDataArchiveFreezeOnHostMock.mockRejectedValue(
          new Error("connect ETIMEDOUT"),
        );
        const result = await recover({
          failure_category: "stuck-manual-archive",
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        });
        expect(result.outcome).toBe("error");
        expect(settled()).toEqual([
          expect.objectContaining({
            job_id: MANUAL_JOB_ID,
            claimed_attempts: 4,
            status: "failed",
            failure_category: "stuck-manual-archive",
            clear_final_backup: false,
            recovery_error: true,
          }),
        ]);
        expect(attestReleasedLroDedupeSuccessesMock).not.toHaveBeenCalled();
      });

      it("retries a host that refuses the connection, unlike one that refuses the release", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        releaseProjectDataArchiveFreezeOnHostMock.mockRejectedValue(
          new Error("connect ECONNREFUSED 10.0.0.1:443"),
        );
        const result = await recover({
          failure_category: "stuck-manual-archive",
          final_backup_id: "final-backup-id",
          backup_generation: 10,
        });
        expect(result.outcome).toBe("error");
        expect(settled()).toEqual([
          expect.objectContaining({
            failure_category: "stuck-manual-archive",
            recovery_error: true,
            claimed_attempts: 4,
          }),
        ]);
      });

      it("quarantines after too many transient failures in a row", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        releaseProjectDataArchiveFreezeOnHostMock.mockRejectedValue(
          new Error("connect ETIMEDOUT"),
        );
        const result = await recover({
          final_backup_id: "final-backup-id",
          backup_generation: 10,
          recovery_errors: 4,
        });
        expect(result.outcome).toBe("quarantined");
        expect(settled()).toEqual([
          expect.objectContaining({
            failure_category: "manual-archive-freeze-quarantined",
            claimed_attempts: 4,
          }),
        ]);
      });

      it("quarantines a project that moved during an unresolved manual archive", async () => {
        listLrosByDedupeMock.mockResolvedValue([succeeded(10)]);
        const result = await recover(
          { final_backup_id: "final-backup-id", backup_generation: 10 },
          manualArchiveRow({ host_id: "host-2" }),
        );
        expect(result.outcome).toBe("quarantined");
        expect(
          releaseProjectDataArchiveFreezeOnHostMock,
        ).not.toHaveBeenCalled();
        expect(updatedProjects()).toHaveLength(0);
      });

      it("leaves a final backup that is still running alone", async () => {
        listLrosByDedupeMock.mockResolvedValue([
          { op_id: "lro-r", status: "running", result: null },
        ]);
        const result = await recover({
          failure_category: "stuck-manual-archive",
        });
        expect(result.outcome).toBe("backup-running");
        expect(
          releaseProjectDataArchiveFreezeOnHostMock,
        ).not.toHaveBeenCalled();
        // handed back unchanged
        expect(settled()).toEqual([
          {
            job_id: MANUAL_JOB_ID,
            claimed_attempts: 4,
            status: "failed",
            failure_category: "stuck-manual-archive",
            clear_final_backup: false,
          },
        ]);
      });
    });
  });
});
