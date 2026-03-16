export {};

let queryMock: jest.Mock;
let cloneMock: jest.Mock;
let hostCreateProjectMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let isCollaboratorMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let computePlacementPermissionMock: jest.Mock;
let getUserHostTierMock: jest.Mock;

const ACCOUNT_ID = "6e22d250-68d4-46fb-9851-80fbeaa2d6b6";
const SOURCE_PROJECT_ID = "9a79d9ef-d6a5-4ae1-a215-f594e864637c";
const HOST_ID = "39d74365-65fe-4f13-8efc-ad6b6e58f3ee";

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: queryMock })),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/projects/is-collaborator", () => ({
  __esModule: true,
  default: (...args: any[]) => isCollaboratorMock(...args),
}));

jest.mock("@cocalc/server/software-envs", () => ({
  __esModule: true,
  getSoftwareEnvironments: jest.fn(async () => ({
    default: "ubuntu2404",
  })),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

jest.mock("@cocalc/conat/project-host/api", () => ({
  __esModule: true,
  createHostControlClient: jest.fn(() => ({
    createProject: (...args: any[]) => hostCreateProjectMock(...args),
  })),
}));

jest.mock("@cocalc/server/project-host/placement", () => ({
  __esModule: true,
  computePlacementPermission: (...args: any[]) =>
    computePlacementPermissionMock(...args),
  getUserHostTier: (...args: any[]) => getUserHostTierMock(...args),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

describe("projects.createProject clone routing", () => {
  beforeEach(() => {
    jest.resetModules();
    cloneMock = jest.fn(async () => undefined);
    hostCreateProjectMock = jest.fn(async () => undefined);
    getProjectFileServerClientMock = jest.fn(async () => ({
      clone: (...args: any[]) => cloneMock(...args),
    }));
    isCollaboratorMock = jest.fn(async () => true);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    computePlacementPermissionMock = jest.fn(() => ({ can_place: true }));
    getUserHostTierMock = jest.fn(() => 0);
    queryMock = jest.fn(async (sql: string, params: any[]) => {
      if (
        sql.includes(
          "SELECT project_id FROM deleted_projects WHERE project_id=$1 LIMIT 1",
        )
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("SELECT project_id FROM projects WHERE project_id=$1 LIMIT 1")
      ) {
        return { rows: [] };
      }
      if (
        sql.includes("SELECT host_id, region FROM projects WHERE project_id=$1")
      ) {
        expect(params).toEqual([SOURCE_PROJECT_ID]);
        return { rows: [{ host_id: HOST_ID, region: "wnam" }] };
      }
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        expect(params).toEqual([HOST_ID]);
        return {
          rows: [
            {
              id: HOST_ID,
              status: "running",
              last_seen: new Date(),
              deleted: null,
              region: "us-west1",
              tier: 0,
              metadata: {
                owner: ACCOUNT_ID,
                collaborators: [],
                machine: { cloud: "gcp" },
              },
            },
          ],
        };
      }
      if (sql.startsWith("INSERT INTO projects ")) {
        expect(params[7]).toBe(HOST_ID);
        expect(params[8]).toBe("wnam");
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  });

  it("uses the routed project file server client for src_project_id clones", async () => {
    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Clone test",
      description: "desc",
      account_id: ACCOUNT_ID,
      src_project_id: SOURCE_PROJECT_ID,
      rootfs_image: "buildpack-deps:noble-scm",
      start: false,
    });

    expect(typeof project_id).toBe("string");
    expect(isCollaboratorMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: SOURCE_PROJECT_ID,
    });
    expect(getProjectFileServerClientMock).toHaveBeenCalledWith({
      project_id: SOURCE_PROJECT_ID,
    });
    expect(cloneMock).toHaveBeenCalledWith({
      project_id,
      src_project_id: SOURCE_PROJECT_ID,
    });
    expect(hostCreateProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        start: false,
      }),
    );
  });
});
