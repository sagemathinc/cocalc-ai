export {};

let queryMock: jest.Mock;
let getLroMock: jest.Mock;
let listLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let dismissLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let cancelCopiesByOpIdMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  dismissLro: (...args: any[]) => dismissLroMock(...args),
  getLro: (...args: any[]) => getLroMock(...args),
  listLro: (...args: any[]) => listLroMock(...args),
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/server/projects/copy-db", () => ({
  __esModule: true,
  cancelCopiesByOpId: (...args: any[]) => cancelCopiesByOpIdMock(...args),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollabAllowRemoteProjectAccess: jest.fn(async () => undefined),
}));

describe("lro host authorization", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.COCALC_BAY_ID = "bay-0";
    getLroMock = jest.fn(async () => ({
      op_id: "op-1",
      kind: "host-upgrade-software",
      scope_type: "host",
      scope_id: "host-1",
      status: "running",
    }));
    listLroMock = jest.fn(async () => [
      {
        op_id: "op-1",
        kind: "host-upgrade-software",
        scope_type: "host",
        scope_id: "host-1",
        status: "running",
      },
    ]);
    updateLroMock = jest.fn(async () => null);
    dismissLroMock = jest.fn(async () => null);
    publishLroSummaryMock = jest.fn(async () => undefined);
    cancelCopiesByOpIdMock = jest.fn(async () => undefined);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("FROM project_hosts")) {
        return {
          rows: [
            {
              metadata: {
                owner: "owner-1",
                collaborators: [],
              },
            },
          ],
        };
      }
      if (sql.includes("FROM projects")) {
        const accountId = params[1];
        return { rowCount: accountId === "project-user" ? 1 : 0, rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  afterEach(() => {
    delete process.env.COCALC_BAY_ID;
  });

  it("allows a project collaborator on the host to list host operations", async () => {
    const { list } = await import("./lro");

    const rows = await list({
      account_id: "project-user",
      scope_type: "host",
      scope_id: "host-1",
      include_completed: true,
    });

    expect(rows).toHaveLength(1);
    expect(listLroMock).toHaveBeenCalledWith({
      scope_type: "host",
      scope_id: "host-1",
      include_completed: true,
    });
  });

  it("does not allow unrelated users to list host operations", async () => {
    const { list } = await import("./lro");

    await expect(
      list({
        account_id: "other-user",
        scope_type: "host",
        scope_id: "host-1",
      }),
    ).rejects.toThrow("not authorized");
  });

  it("does not let project collaborators cancel host operations", async () => {
    const { cancel } = await import("./lro");

    await expect(
      cancel({
        account_id: "project-user",
        op_id: "op-1",
      }),
    ).rejects.toThrow("not authorized");

    expect(updateLroMock).not.toHaveBeenCalled();
  });
});
