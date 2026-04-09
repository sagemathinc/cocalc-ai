export {};

let queryMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let projectReferenceGetMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectReference: jest.fn(() => ({
      get: (...args: any[]) => projectReferenceGetMock(...args),
    })),
  })),
}));

describe("project-host token bay checks", () => {
  const HOST_UUID = "00000000-0000-4000-8000-000000000123";
  const ACCOUNT_UUID = "00000000-0000-4000-8000-000000000124";
  const PROJECT_UUID = "00000000-0000-4000-8000-000000000125";

  beforeEach(() => {
    jest.resetModules();
    resolveProjectBayMock = jest.fn();
    projectReferenceGetMock = jest.fn();
  });

  it("allows browser-issued project-host token access for a local collaborator", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      expect(sql).toContain("COALESCE(projects.owning_bay_id, $3)");
      expect(sql).toContain("projects.deleted IS NOT true");
      expect(params).toEqual([PROJECT_UUID, ACCOUNT_UUID, "bay-0"]);
      return {
        rows: [
          {
            host_id: HOST_UUID,
            project_owning_bay_id: "bay-0",
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
    ).resolves.toBeUndefined();
  });

  it("allows remote collaborator browser-issued project-host token access when the owning bay confirms visibility", async () => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 3,
    }));
    projectReferenceGetMock = jest.fn(async () => ({
      project_id: PROJECT_UUID,
      host_id: HOST_UUID,
      title: "Remote Project",
      owning_bay_id: "bay-7",
    }));

    const { assertAccountProjectHostTokenProjectAccess } =
      await import("./project-host-token-auth");
    await expect(
      assertAccountProjectHostTokenProjectAccess({
        account_id: ACCOUNT_UUID,
        host_id: HOST_UUID,
        project_id: PROJECT_UUID,
      }),
    ).resolves.toBeUndefined();
  });

  it("requires host/project access for host-scoped project-host browser tokens", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      expect(sql).toContain("COALESCE(projects.owning_bay_id, $3)");
      expect(sql).toContain("projects.deleted IS NOT true");
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
      expect(sql).toContain("projects.deleted IS NOT true");
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
