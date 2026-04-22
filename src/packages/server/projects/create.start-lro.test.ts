export {};

let queryMock: jest.Mock;
let getProjectMock: jest.Mock;
let createLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let initializeProjectRootfsStatesMock: jest.Mock;
let cloneProjectRootfsStatesMock: jest.Mock;
let takeStartProjectPhaseTimingsMock: jest.Mock;
let delayMock: jest.Mock;
let mirrorStartLroProgressMock: jest.Mock;
let supersedeOlderProjectStartLrosMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let assertBayAcceptsProjectOwnershipMock: jest.Mock;
let poolConnectMock: jest.Mock;
let releaseMock: jest.Mock;

async function flushBackgroundStartTask() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
    connect: poolConnectMock,
  })),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  __esModule: true,
  appendProjectOutboxEventForProject: (...args: any[]) =>
    appendProjectOutboxEventForProjectMock(...args),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  __esModule: true,
  publishProjectAccountFeedEventsBestEffort: (...args: any[]) =>
    publishProjectAccountFeedEventsBestEffortMock(...args),
}));

jest.mock("@cocalc/server/bay-registry", () => ({
  __esModule: true,
  assertBayAcceptsProjectOwnership: (...args: any[]) =>
    assertBayAcceptsProjectOwnershipMock(...args),
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
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/projects/control", () => ({
  __esModule: true,
  getProject: (...args: any[]) => getProjectMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: jest.fn(),
}));

jest.mock("@cocalc/server/project-host/placement", () => ({
  __esModule: true,
  computePlacementPermission: jest.fn(() => ({ can_place: true })),
  getUserHostTier: jest.fn(() => 0),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: jest.fn(async () => ({ entitlements: {} })),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  initializeProjectRootfsStates: (...args: any[]) =>
    initializeProjectRootfsStatesMock(...args),
  cloneProjectRootfsStates: (...args: any[]) =>
    cloneProjectRootfsStatesMock(...args),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/server/project-host/control", () => ({
  __esModule: true,
  takeStartProjectPhaseTimings: (...args: any[]) =>
    takeStartProjectPhaseTimingsMock(...args),
}));

jest.mock("@cocalc/server/projects/start-lro-progress", () => ({
  __esModule: true,
  mirrorStartLroProgress: (...args: any[]) =>
    mirrorStartLroProgressMock(...args),
}));

jest.mock("@cocalc/server/projects/start-lro-cleanup", () => ({
  __esModule: true,
  supersedeOlderProjectStartLros: (...args: any[]) =>
    supersedeOlderProjectStartLrosMock(...args),
}));

jest.mock("awaiting", () => ({
  __esModule: true,
  delay: (...args: any[]) => delayMock(...args),
}));

describe("projects.createProject start LRO", () => {
  const ACCOUNT_ID = "6e22d250-68d4-46fb-9851-80fbeaa2d6b6";

  beforeEach(() => {
    jest.resetModules();
    appendProjectOutboxEventForProjectMock = jest.fn(async () => "event-id");
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    assertBayAcceptsProjectOwnershipMock = jest.fn(async () => undefined);
    releaseMock = jest.fn();
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (
        sql.includes(
          "SELECT project_id FROM deleted_projects WHERE project_id=$1 LIMIT 1",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes(
          "SELECT project_id FROM projects WHERE project_id=$1 LIMIT 1",
        )
      ) {
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO projects ")) {
        return { rowCount: 1 };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return { rows: [{ state: { state: "running" } }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
    getProjectMock = jest.fn(() => ({
      start: jest.fn(async () => undefined),
      saveStateToDatabase: jest.fn(async () => undefined),
    }));
    createLroMock = jest.fn(async ({ scope_id }: { scope_id: string }) => ({
      op_id: "op-1",
      kind: "project-start",
      scope_type: "project",
      scope_id,
      status: "queued",
    }));
    updateLroMock = jest.fn(
      async ({ status }: { op_id: string; status: string }) => ({
        op_id: "op-1",
        kind: "project-start",
        scope_type: "project",
        scope_id: queryMock.mock.calls.find((call) =>
          `${call[0]}`.startsWith("INSERT INTO projects "),
        )?.[1]?.[0],
        status,
      }),
    );
    publishLroEventMock = jest.fn(async () => undefined);
    publishLroSummaryMock = jest.fn(async () => undefined);
    initializeProjectRootfsStatesMock = jest.fn(async () => undefined);
    cloneProjectRootfsStatesMock = jest.fn(async () => undefined);
    takeStartProjectPhaseTimingsMock = jest.fn(() => ({ cache_rootfs: 1234 }));
    delayMock = jest.fn(async () => undefined);
    mirrorStartLroProgressMock = jest.fn(async () => async () => undefined);
    supersedeOlderProjectStartLrosMock = jest.fn(async () => undefined);
  });

  it("creates and updates a project-start LRO for create-with-start", async () => {
    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Untitled",
      description: "",
      account_id: ACCOUNT_ID,
      start: true,
    });

    await flushBackgroundStartTask();

    expect(typeof project_id).toBe("string");
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-start",
        scope_type: "project",
        scope_id: project_id,
        created_by: ACCOUNT_ID,
        routing: "hub",
        input: { project_id },
        status: "queued",
      }),
    );
    const project = getProjectMock.mock.results[0]?.value;
    expect(project.start).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      lro_op_id: "op-1",
    });
    expect(queryMock).toHaveBeenCalledWith(
      "SELECT state FROM projects WHERE project_id=$1",
      [project_id],
    );
    expect(updateLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op-1",
        status: "running",
        error: null,
      }),
    );
    expect(updateLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op-1",
        status: "succeeded",
        error: null,
        result: expect.objectContaining({
          done: 1,
          total: 1,
          phase_timings_ms: { cache_rootfs: 1234 },
        }),
      }),
    );
    expect(supersedeOlderProjectStartLrosMock).toHaveBeenCalledWith({
      project_id,
      keep_op_id: "op-1",
    });
    expect(publishLroEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        scope_type: "project",
        scope_id: project_id,
        op_id: "op-1",
      }),
    );
  });

  it("still starts the project if LRO creation fails", async () => {
    createLroMock.mockRejectedValueOnce(new Error("lro unavailable"));
    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Untitled",
      description: "",
      account_id: ACCOUNT_ID,
      start: true,
    });

    await flushBackgroundStartTask();

    const project = getProjectMock.mock.results[0]?.value;
    expect(typeof project_id).toBe("string");
    expect(project.start).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      lro_op_id: undefined,
    });
    expect(updateLroMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
      }),
    );
  });
});
