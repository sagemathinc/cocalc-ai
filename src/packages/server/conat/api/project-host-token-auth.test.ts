export {};

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

describe("project-host token bay checks", () => {
  const HOST_UUID = "00000000-0000-4000-8000-000000000123";
  const ACCOUNT_UUID = "00000000-0000-4000-8000-000000000124";
  const PROJECT_UUID = "00000000-0000-4000-8000-000000000125";

  beforeEach(() => {
    jest.resetModules();
  });

  it("rejects browser-issued project-host token access when project and host bays differ", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      expect(sql).toContain("COALESCE(projects.owning_bay_id, $3)");
      expect(params).toEqual([PROJECT_UUID, ACCOUNT_UUID, "bay-0"]);
      return {
        rows: [
          {
            host_id: HOST_UUID,
            project_owning_bay_id: "bay-7",
            host_bay_id: "bay-9",
            group: "owner",
          },
        ],
      };
    });

    const { assertAccountProjectHostTokenProjectAccess } =
      await import("./project-host-token-auth");
    await expect(
      assertAccountProjectHostTokenProjectAccess({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).rejects.toThrow("project bay does not match the requested host");
  });

  it("requires bay-consistent host/project access for host-scoped project-host browser tokens", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      expect(sql).toContain("COALESCE(projects.owning_bay_id, $3)");
      expect(params).toEqual([HOST_UUID, ACCOUNT_UUID, "bay-0"]);
      return { rowCount: 0 };
    });

    const { hasAccountProjectHostTokenHostAccess } =
      await import("./project-host-token-auth");
    await expect(
      hasAccountProjectHostTokenHostAccess({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
      }),
    ).resolves.toBe(false);
  });

  it("rejects host-issued agent tokens when project and host bays differ", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      expect(sql).toContain("COALESCE(projects.owning_bay_id, $4)");
      expect(params).toEqual([PROJECT_UUID, HOST_UUID, ACCOUNT_UUID, "bay-0"]);
      return { rowCount: 0 };
    });

    const { assertProjectHostAgentTokenAccess } =
      await import("./project-host-token-auth");
    await expect(
      assertProjectHostAgentTokenAccess({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).rejects.toThrow("not authorized for project-host agent auth token");
  });
});
