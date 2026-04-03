export {};

let queryMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;

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

describe("supersedeOlderProjectStartLros", () => {
  beforeEach(() => {
    jest.resetModules();
    queryMock = jest.fn(async () => ({
      rows: [
        {
          op_id: "old-op-1",
          scope_type: "project",
          scope_id: "proj-1",
          error: null,
        },
      ],
    }));
    updateLroMock = jest.fn(async ({ op_id, status, error }) => ({
      op_id,
      scope_type: "project",
      scope_id: "proj-1",
      status,
      error,
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
  });

  it("cancels older queued/running project-start lros after a later success", async () => {
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
});
