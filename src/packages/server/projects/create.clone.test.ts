export {};

let queryMock: jest.Mock;
let cloneMock: jest.Mock;
let hostCreateProjectMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let assertLocalProjectCollaboratorMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let computePlacementPermissionMock: jest.Mock;
let getUserHostTierMock: jest.Mock;
let getExplicitHostRoutedClientMock: jest.Mock;
let appendProjectOutboxEventForProjectMock: jest.Mock;
let publishProjectAccountFeedEventsBestEffortMock: jest.Mock;
let assertBayAcceptsProjectOwnershipMock: jest.Mock;
let poolConnectMock: jest.Mock;
let releaseMock: jest.Mock;
let resolveHostBayMock: jest.Mock;
let hostConnectionGetMock: jest.Mock;
let hostControlCreateProjectMock: jest.Mock;
let insertedProjectId: string | undefined;

const ACCOUNT_ID = "6e22d250-68d4-46fb-9851-80fbeaa2d6b6";
const SOURCE_PROJECT_ID = "9a79d9ef-d6a5-4ae1-a215-f594e864637c";
const HOST_ID = "39d74365-65fe-4f13-8efc-ad6b6e58f3ee";

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

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  assertLocalProjectCollaborator: (...args: any[]) =>
    assertLocalProjectCollaboratorMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  __esModule: true,
  getExplicitHostRoutedClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
  getExplicitHostControlClient: (...args: any[]) =>
    getExplicitHostRoutedClientMock(...args),
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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveHostBay: (...args: any[]) => resolveHostBayMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    hostConnection: jest.fn(() => ({
      get: (...args: any[]) => hostConnectionGetMock(...args),
    })),
    hostControl: jest.fn(() => ({
      createProject: (...args: any[]) => hostControlCreateProjectMock(...args),
    })),
  })),
}));

describe("projects.createProject clone routing", () => {
  beforeEach(() => {
    jest.resetModules();
    insertedProjectId = undefined;
    cloneMock = jest.fn(async () => undefined);
    hostCreateProjectMock = jest.fn(async () => undefined);
    getProjectFileServerClientMock = jest.fn(async () => ({
      clone: (...args: any[]) => cloneMock(...args),
    }));
    assertLocalProjectCollaboratorMock = jest.fn(async () => undefined);
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {},
    }));
    computePlacementPermissionMock = jest.fn(() => ({ can_place: true }));
    getUserHostTierMock = jest.fn(() => 0);
    getExplicitHostRoutedClientMock = jest.fn(async () => ({
      id: "mock-conat-client",
    }));
    appendProjectOutboxEventForProjectMock = jest.fn(async () => "event-id");
    publishProjectAccountFeedEventsBestEffortMock = jest.fn(
      async () => undefined,
    );
    assertBayAcceptsProjectOwnershipMock = jest.fn(async () => undefined);
    resolveHostBayMock = jest.fn(async () => null);
    hostConnectionGetMock = jest.fn();
    hostControlCreateProjectMock = jest.fn(async () => ({
      project_id: insertedProjectId,
      state: { state: "stopped" },
    }));
    releaseMock = jest.fn();
    queryMock = jest.fn(async (sql: string, params: any[]) => {
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
      if (
        sql.includes(
          "SELECT host_id, region, rootfs_image, rootfs_image_id, owning_bay_id FROM projects WHERE project_id=$1",
        )
      ) {
        expect(params).toEqual([SOURCE_PROJECT_ID]);
        return {
          rows: [
            {
              host_id: HOST_ID,
              region: "wnam",
              rootfs_image: "buildpack-deps:noble-scm",
              rootfs_image_id: "official-cocalc-base",
              owning_bay_id: "bay-3",
            },
          ],
        };
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
              bay_id: "bay-7",
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
        insertedProjectId = params[0];
        expect(params[7]).toBe(HOST_ID);
        expect(params[8]).toBe("wnam");
        expect(params[9]).toBe("bay-0");
        return { rowCount: 1 };
      }
      if (sql.includes("INSERT INTO project_rootfs_states")) {
        expect(params[0]).toBe(insertedProjectId);
        expect(params[1]).toBe(SOURCE_PROJECT_ID);
        return { rowCount: 1 };
      }
      if (
        sql.includes("FROM project_rootfs_states") &&
        sql.includes(
          "ORDER BY CASE state_role WHEN 'current' THEN 0 ELSE 1 END",
        )
      ) {
        expect(params).toEqual([insertedProjectId]);
        return {
          rows: [
            {
              project_id: insertedProjectId,
              state_role: "current",
              runtime_image: "buildpack-deps:noble-scm",
              release_id: null,
              image_id: "official-cocalc-base",
              set_by_account_id: null,
              created: new Date(),
              updated: new Date(),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
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
    expect(assertLocalProjectCollaboratorMock).toHaveBeenCalledWith({
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
    expect(hostControlCreateProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        host_id: HOST_ID,
        create: expect.objectContaining({
          project_id,
          start: false,
        }),
      }),
    );
  });

  it("rejects clone creation when the source project belongs to another bay", async () => {
    assertLocalProjectCollaboratorMock = jest.fn(async () => {
      throw new Error("project belongs to another bay");
    });
    const createProject = (await import("./create")).default;
    await expect(
      createProject({
        title: "Clone test",
        description: "desc",
        account_id: ACCOUNT_ID,
        src_project_id: SOURCE_PROJECT_ID,
        rootfs_image: "buildpack-deps:noble-scm",
        start: false,
      }),
    ).rejects.toThrow("project belongs to another bay");
    expect(getProjectFileServerClientMock).not.toHaveBeenCalled();
    expect(cloneMock).not.toHaveBeenCalled();
    expect(hostCreateProjectMock).not.toHaveBeenCalled();
  });

  it("creates a project on a host owned by another bay when remote placement is allowed", async () => {
    queryMock = jest.fn(async (sql: string, params: any[]) => {
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
      if (sql.includes("SELECT * FROM project_hosts WHERE id=$1")) {
        expect(params).toEqual([HOST_ID]);
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO projects ")) {
        insertedProjectId = params[0];
        expect(params[7]).toBe(HOST_ID);
        expect(params[8]).toBe("wnam");
        expect(params[9]).toBe("bay-0");
        return { rowCount: 1 };
      }
      if (
        sql.includes("SELECT release_id") &&
        sql.includes("FROM rootfs_images")
      ) {
        expect(params).toEqual(["buildpack-deps:noble-scm"]);
        return { rows: [{ release_id: null }] };
      }
      if (
        sql.includes("SELECT release_id") &&
        sql.includes("FROM rootfs_releases")
      ) {
        expect(params).toEqual(["buildpack-deps:noble-scm"]);
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO project_rootfs_states")) {
        return { rowCount: 1 };
      }
      if (
        sql.includes("FROM project_rootfs_states") &&
        sql.includes(
          "ORDER BY CASE state_role WHEN 'current' THEN 0 ELSE 1 END",
        )
      ) {
        return {
          rows: [
            {
              project_id: insertedProjectId,
              state_role: "current",
              runtime_image: "buildpack-deps:noble-scm",
              release_id: null,
              image_id: null,
              set_by_account_id: null,
              created: new Date(),
              updated: new Date(),
            },
          ],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    poolConnectMock = jest.fn(async () => ({
      query: queryMock,
      release: releaseMock,
    }));
    resolveHostBayMock = jest.fn(async () => ({
      bay_id: "bay-7",
      epoch: 1,
    }));
    hostConnectionGetMock = jest.fn(async ({ account_id, host_id }) => {
      expect(account_id).toBe(ACCOUNT_ID);
      expect(host_id).toBe(HOST_ID);
      return {
        host_id: HOST_ID,
        bay_id: "bay-7",
        region: "us-west1",
        can_place: true,
        status: "running",
        online: true,
      };
    });

    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Remote host placement",
      description: "",
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      rootfs_image: "buildpack-deps:noble-scm",
      start: false,
    });

    expect(typeof project_id).toBe("string");
    expect(resolveHostBayMock).toHaveBeenCalledWith(HOST_ID);
    expect(hostConnectionGetMock).toHaveBeenCalledTimes(1);
    expect(hostControlCreateProjectMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      create: {
        image: "buildpack-deps:noble-scm",
        project_id,
        start: false,
        title: "Remote host placement",
        users: { [ACCOUNT_ID]: { group: "owner" } },
      },
    });
  });
});
