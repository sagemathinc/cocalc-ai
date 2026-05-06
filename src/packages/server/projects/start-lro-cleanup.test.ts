export {};

let queryMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let getProjectActiveOperationMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/server/projects/active-operation", () => ({
  __esModule: true,
  getProjectActiveOperation: (...args: any[]) =>
    getProjectActiveOperationMock(...args),
}));

describe("supersedeOlderProjectStartLros", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({ rows: [] }));
    updateLroMock = jest.fn(async ({ op_id, status, error }) => ({
      op_id,
      scope_type: "project",
      scope_id: "proj-1",
      status,
      error,
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    getProjectActiveOperationMock = jest.fn(async () => null);
  });

  it("cancels older queued/running project-start lros after a later success", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM long_running_operations")) {
        return {
          rows: [
            {
              op_id: "old-op-1",
              scope_type: "project",
              scope_id: "proj-1",
              error: null,
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const { supersedeOlderProjectStartLros } =
      await import("./start-lro-cleanup");
    await supersedeOlderProjectStartLros({
      project_id: "proj-1",
      keep_op_id: "new-op-1",
    });

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("FROM long_running_operations"),
      ["proj-1", "new-op-1", ["queued", "running"]],
    );
    expect(updateLroMock).toHaveBeenCalledWith({
      op_id: "old-op-1",
      status: "canceled",
      error: "superseded by later successful project start new-op-1",
    });
    expect(publishLroSummaryMock).toHaveBeenCalledWith({
      scope_type: "project",
      scope_id: "proj-1",
      summary: expect.objectContaining({
        op_id: "old-op-1",
        status: "canceled",
      }),
    });
  });

  it("returns immediately when there is no keep op id", async () => {
    const { supersedeOlderProjectStartLros } =
      await import("./start-lro-cleanup");
    await supersedeOlderProjectStartLros({
      project_id: "proj-1",
      keep_op_id: undefined,
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(updateLroMock).not.toHaveBeenCalled();
  });

  it("cancels orphaned active project-start lros when the project is not starting", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM long_running_operations")) {
        return {
          rows: [
            {
              op_id: "old-op-1",
              scope_type: "project",
              scope_id: "proj-1",
              error: null,
              created_at: "2026-05-06T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [{ state: { state: "opened", time: "2026-05-06T12:00:00Z" } }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { cancelStaleProjectStartLros } = await import("./start-lro-cleanup");
    const canceled = await cancelStaleProjectStartLros({
      project_id: "proj-1",
      nowMs: Date.UTC(2026, 4, 6, 12, 5, 0),
    });

    expect(canceled).toBe(1);
    expect(getProjectActiveOperationMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(updateLroMock).toHaveBeenCalledWith({
      op_id: "old-op-1",
      status: "canceled",
      error: "orphaned project start operation",
    });
  });

  it("keeps the newest recent starting op during the grace window when no active operation exists", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM long_running_operations")) {
        return {
          rows: [
            {
              op_id: "new-op-1",
              scope_type: "project",
              scope_id: "proj-1",
              error: null,
              created_at: "2026-05-06T12:04:45.000Z",
            },
          ],
        };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [
            {
              state: {
                state: "starting",
                time: "2026-05-06T12:04:40.000Z",
              },
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { cancelStaleProjectStartLros } = await import("./start-lro-cleanup");
    const canceled = await cancelStaleProjectStartLros({
      project_id: "proj-1",
      nowMs: Date.UTC(2026, 4, 6, 12, 5, 0),
    });

    expect(canceled).toBe(0);
    expect(updateLroMock).not.toHaveBeenCalled();
  });

  it("cancels duplicate active start lros when another start is the current active operation", async () => {
    getProjectActiveOperationMock = jest.fn(async () => ({
      project_id: "proj-1",
      op_id: "current-op-1",
      kind: "project-start",
      action: "start",
      status: "running",
      updated_at: new Date("2026-05-06T12:05:00.000Z"),
    }));
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM long_running_operations")) {
        return {
          rows: [
            {
              op_id: "current-op-1",
              scope_type: "project",
              scope_id: "proj-1",
              error: null,
              created_at: "2026-05-06T12:04:50.000Z",
            },
            {
              op_id: "old-op-1",
              scope_type: "project",
              scope_id: "proj-1",
              error: null,
              created_at: "2026-05-06T12:00:00.000Z",
            },
          ],
        };
      }
      if (sql === "SELECT state FROM projects WHERE project_id=$1") {
        return {
          rows: [
            { state: { state: "starting", time: "2026-05-06T12:04:40Z" } },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const { cancelStaleProjectStartLros } = await import("./start-lro-cleanup");
    const canceled = await cancelStaleProjectStartLros({
      project_id: "proj-1",
      nowMs: Date.UTC(2026, 4, 6, 12, 5, 0),
    });

    expect(canceled).toBe(1);
    expect(updateLroMock).toHaveBeenCalledWith({
      op_id: "old-op-1",
      status: "canceled",
      error: "superseded by active project start current-op-1",
    });
  });
});
