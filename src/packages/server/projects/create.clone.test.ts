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
let getMembershipUsageStatusForAccountMock: jest.Mock;
let peekCachedMembershipUsageStatusForAccountMock: jest.Mock;
let resolveProjectBackupRepoAssignmentMock: jest.Mock;
let poolConnectMock: jest.Mock;
let releaseMock: jest.Mock;
let resolveHostBayMock: jest.Mock;
let hostConnectionGetMock: jest.Mock;
let hostControlCreateProjectMock: jest.Mock;
let copyProjectSecretsMock: jest.Mock;
let initializeProjectRootfsStatesMock: jest.Mock;
let cloneProjectRootfsStatesMock: jest.Mock;
let insertedProjectId: string | undefined;

const ACCOUNT_ID = "6e22d250-68d4-46fb-9851-80fbeaa2d6b6";
const SOURCE_PROJECT_ID = "9a79d9ef-d6a5-4ae1-a215-f594e864637c";
const HOST_ID = "39d74365-65fe-4f13-8efc-ad6b6e58f3ee";
const STAR_ROOTFS_IMAGE =
  "cocalc.local/rootfs/113f7173e66b81668ebf6f460485d38144e1026f50679d22241b272bcefb7e42";
const STAR_ROOTFS_IMAGE_ID = "official-cocalc-star-rootfs";
const CATALOG_ROOTFS_IMAGE =
  "cocalc.local/rootfs/3b5851d22bb2e1cdf6dce416bd61c93227c56acfd54a2a3651632279e6e30fb7";
const CATALOG_ROOTFS_IMAGE_ID = "493a9f2b-07df-4bfa-b98a-7122187d4027";

function isRootfsScanSelectionQuery(sql: string): boolean {
  return (
    sql.includes("SELECT img.image_id") &&
    sql.includes("FROM rootfs_images AS img") &&
    sql.includes("LEFT JOIN rootfs_releases AS rel")
  );
}

function rootfsScanAllowedRows({
  image_id = "official-cocalc-base",
  release_id = null,
}: {
  image_id?: string;
  release_id?: string | null;
} = {}) {
  return {
    rows: [
      {
        image_id,
        release_id,
        official: true,
        scan_status: null,
        scan_tool: null,
        scanned_at: null,
        scan_summary: null,
      },
    ],
  };
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

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: jest.fn(async () => ({
    verify_emails: false,
    email_enabled: false,
    email_backend: "none",
  })),
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

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: (...args: any[]) =>
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

jest.mock("@cocalc/server/project-host/access", () => ({
  __esModule: true,
  getHostAccessForAccount: jest.fn(async () => ({
    role: "owner",
    delegated_role: undefined,
    exists: true,
  })),
}));

jest.mock("@cocalc/server/membership/resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("@cocalc/server/membership/usage-status", () => ({
  __esModule: true,
  getMembershipUsageStatusForAccount: (...args: any[]) =>
    getMembershipUsageStatusForAccountMock(...args),
  peekCachedMembershipUsageStatusForAccount: (...args: any[]) =>
    peekCachedMembershipUsageStatusForAccountMock(...args),
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

jest.mock("@cocalc/server/project-backup", () => ({
  __esModule: true,
  resolveProjectBackupRepoAssignment: (...args: any[]) =>
    resolveProjectBackupRepoAssignmentMock(...args),
}));

jest.mock("@cocalc/server/projects/project-secrets", () => ({
  __esModule: true,
  copyProjectSecrets: (...args: any[]) => copyProjectSecretsMock(...args),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  initializeProjectRootfsStates: (...args: any[]) =>
    initializeProjectRootfsStatesMock(...args),
  cloneProjectRootfsStates: (...args: any[]) =>
    cloneProjectRootfsStatesMock(...args),
}));

describe("projects.createProject clone routing", () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_SETUP_PROFILE;
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
    getMembershipUsageStatusForAccountMock = jest.fn(async () => ({
      total_storage_bytes: 0,
    }));
    peekCachedMembershipUsageStatusForAccountMock = jest.fn(() => ({
      total_storage_bytes: 0,
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
    resolveProjectBackupRepoAssignmentMock = jest.fn(async () => ({
      backup_repo_id: null,
    }));
    resolveHostBayMock = jest.fn(async () => null);
    hostConnectionGetMock = jest.fn();
    hostControlCreateProjectMock = jest.fn(async () => ({
      project_id: insertedProjectId,
      state: { state: "stopped" },
    }));
    copyProjectSecretsMock = jest.fn(async () => ({
      copied: ["API_KEY"],
      conflicts: [],
      missing: [],
    }));
    initializeProjectRootfsStatesMock = jest.fn(async () => undefined);
    cloneProjectRootfsStatesMock = jest.fn(async () => undefined);
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
        sql.includes("SELECT runtime_image") &&
        sql.includes("FROM rootfs_images") &&
        sql.includes("WHERE image_id=$1")
      ) {
        expect(params).toEqual([CATALOG_ROOTFS_IMAGE_ID]);
        return { rows: [{ runtime_image: CATALOG_ROOTFS_IMAGE }] };
      }
      if (
        sql.includes("SELECT COUNT(*)::BIGINT AS count") &&
        sql.includes("COALESCE(users -> $1::text ->> 'group', '') = 'owner'")
      ) {
        return { rows: [{ count: "0" }] };
      }
      if (
        sql.includes(
          "SELECT host_id, region, rootfs_image, rootfs_image_id, owning_bay_id, backup_repo_id FROM projects WHERE project_id=$1",
        )
      ) {
        expect(params).toEqual([SOURCE_PROJECT_ID]);
        return {
          rows: [
            {
              host_id: HOST_ID,
              region: "wnam",
              rootfs_image: "cocalc.local/rootfs/base",
              rootfs_image_id: "official-cocalc-base",
              owning_bay_id: "bay-3",
              backup_repo_id: null,
            },
          ],
        };
      }
      if (
        sql.includes("SELECT runtime_image AS image") &&
        sql.includes("FROM project_rootfs_states") &&
        sql.includes("state_role='current'")
      ) {
        expect(params).toEqual([SOURCE_PROJECT_ID]);
        return { rows: [] };
      }
      if (isRootfsScanSelectionQuery(sql)) {
        return rootfsScanAllowedRows();
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
        if (params[5] === CATALOG_ROOTFS_IMAGE_ID) {
          expect(params[4]).toBe(CATALOG_ROOTFS_IMAGE);
        }
        expect(params[7]).toBe(HOST_ID);
        expect(params[8]).toBe("wnam");
        expect(params[9]).toBe("bay-0");
        return { rowCount: 1 };
      }
      if (sql === "DELETE FROM projects WHERE project_id=$1") {
        return { rowCount: 1 };
      }
      if (sql.includes("INSERT INTO project_rootfs_states")) {
        expect(params[0]).toBe(insertedProjectId);
        if (params[2] === CATALOG_ROOTFS_IMAGE_ID) {
          expect(params[1]).toBe(CATALOG_ROOTFS_IMAGE);
        } else {
          expect(params[1]).toBe(SOURCE_PROJECT_ID);
        }
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
              runtime_image: "cocalc.local/rootfs/base",
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

  it("resolves a managed rootfs image id to the runtime image during project creation", async () => {
    const createProject = (await import("./create")).default;

    const project_id = await createProject({
      title: "Catalog image test",
      description: "desc",
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      rootfs_image_id: CATALOG_ROOTFS_IMAGE_ID,
      start: false,
    });

    expect(project_id).toBe(insertedProjectId);
    expect(initializeProjectRootfsStatesMock).toHaveBeenCalledWith({
      project_id,
      image: CATALOG_ROOTFS_IMAGE,
      image_id: CATALOG_ROOTFS_IMAGE_ID,
      set_by_account_id: ACCOUNT_ID,
    });
    expect(hostControlCreateProjectMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      create: {
        project_id,
        title: "Catalog image test",
        users: { [ACCOUNT_ID]: { group: "owner" } },
        image: CATALOG_ROOTFS_IMAGE,
        start: false,
      },
    });
  });

  it("uses the routed project file server client for src_project_id clones", async () => {
    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Clone test",
      description: "desc",
      account_id: ACCOUNT_ID,
      src_project_id: SOURCE_PROJECT_ID,
      rootfs_image: "cocalc.local/rootfs/base",
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
    expect(copyProjectSecretsMock).toHaveBeenCalledWith({
      source_project_id: SOURCE_PROJECT_ID,
      target_project_id: project_id,
      account_id: ACCOUNT_ID,
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

  it("uses the official Star RootFS as the server-side default in the Star profile", async () => {
    process.env.COCALC_SETUP_PROFILE = "star";
    let insertedRootfsImage: string | null = null;
    let insertedRootfsImageId: string | null = null;
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
        sql.includes("SELECT COUNT(*)::BIGINT AS count") &&
        sql.includes("COALESCE(users -> $1::text ->> 'group', '') = 'owner'")
      ) {
        return { rows: [{ count: "0" }] };
      }
      if (
        sql.includes("SELECT runtime_image") &&
        sql.includes("FROM rootfs_images") &&
        sql.includes("WHERE image_id=$1")
      ) {
        expect(params).toEqual([STAR_ROOTFS_IMAGE_ID]);
        return { rows: [{ runtime_image: STAR_ROOTFS_IMAGE }] };
      }
      if (isRootfsScanSelectionQuery(sql)) {
        return rootfsScanAllowedRows({ image_id: STAR_ROOTFS_IMAGE_ID });
      }
      if (sql.startsWith("INSERT INTO projects ")) {
        insertedProjectId = params[0];
        insertedRootfsImage = params[4];
        insertedRootfsImageId = params[5];
        return { rowCount: 1 };
      }
      if (sql.includes("INSERT INTO project_rootfs_states")) {
        expect(params[0]).toBe(insertedProjectId);
        expect(params[2]).toBe(STAR_ROOTFS_IMAGE);
        expect(params[4]).toBe(STAR_ROOTFS_IMAGE_ID);
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const createProject = (await import("./create")).default;
    const project_id = await createProject({
      title: "Star default RootFS test",
      description: "desc",
      account_id: ACCOUNT_ID,
      start: false,
    });

    expect(typeof project_id).toBe("string");
    expect(insertedRootfsImage).toBe(STAR_ROOTFS_IMAGE);
    expect(insertedRootfsImageId).toBe(STAR_ROOTFS_IMAGE_ID);
    expect(initializeProjectRootfsStatesMock).toHaveBeenCalledWith({
      project_id,
      image: STAR_ROOTFS_IMAGE,
      image_id: STAR_ROOTFS_IMAGE_ID,
      set_by_account_id: ACCOUNT_ID,
    });
  });

  it("validates the cloned current RootFS state before copying files", async () => {
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
        sql.includes("SELECT COUNT(*)::BIGINT AS count") &&
        sql.includes("COALESCE(users -> $1::text ->> 'group', '') = 'owner'")
      ) {
        return { rows: [{ count: "0" }] };
      }
      if (
        sql.includes(
          "SELECT host_id, region, rootfs_image, rootfs_image_id, owning_bay_id, backup_repo_id FROM projects WHERE project_id=$1",
        )
      ) {
        return {
          rows: [
            {
              host_id: HOST_ID,
              region: "wnam",
              rootfs_image: "buildpack-deps:noble-scm",
              rootfs_image_id: "official-cocalc-base",
              owning_bay_id: "bay-3",
              backup_repo_id: null,
            },
          ],
        };
      }
      if (
        sql.includes("SELECT runtime_image AS image") &&
        sql.includes("FROM project_rootfs_states") &&
        sql.includes("state_role='current'")
      ) {
        return {
          rows: [
            {
              image: "docker.io/library/ubuntu:latest",
              image_id: null,
            },
          ],
        };
      }
      if (isRootfsScanSelectionQuery(sql)) {
        return { rows: [] };
      }
      if (sql.includes("COALESCE(official, false) OR COALESCE(prepull")) {
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: {
        usage_limits: {
          rootfs_oci_images: false,
        },
      },
    }));
    const createProject = (await import("./create")).default;

    await expect(
      createProject({
        title: "Clone test",
        description: "desc",
        account_id: ACCOUNT_ID,
        src_project_id: SOURCE_PROJECT_ID,
        rootfs_image: "cocalc.local/rootfs/base",
        rootfs_image_id: "official-cocalc-base",
        start: false,
      }),
    ).rejects.toThrow(
      "arbitrary remote OCI root filesystem images are disabled",
    );

    expect(getProjectFileServerClientMock).not.toHaveBeenCalled();
    expect(cloneMock).not.toHaveBeenCalled();
    expect(hostControlCreateProjectMock).not.toHaveBeenCalled();
  });

  it("fails clone creation when project secrets cannot be copied", async () => {
    copyProjectSecretsMock = jest.fn(async () => {
      throw new Error("secret copy failed");
    });
    const createProject = (await import("./create")).default;

    await expect(
      createProject({
        title: "Clone test",
        description: "desc",
        account_id: ACCOUNT_ID,
        src_project_id: SOURCE_PROJECT_ID,
        rootfs_image: "cocalc.local/rootfs/base",
        start: false,
      }),
    ).rejects.toThrow("failed to copy project secrets for clone");

    expect(queryMock).toHaveBeenCalledWith(
      "DELETE FROM projects WHERE project_id=$1",
      [insertedProjectId],
    );
    expect(hostControlCreateProjectMock).not.toHaveBeenCalled();
  });

  it("blocks project creation when the owner already reached max_projects", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: null };
      }
      if (
        sql.includes("SELECT") &&
        sql.includes("p.project_id") &&
        sql.includes("FROM projects AS p")
      ) {
        return {
          rows: [
            {
              project_id: "project-1",
              host_id: null,
              provisioned: false,
              owner_account_id: ACCOUNT_ID,
              usage_account_id: null,
              course: null,
            },
            {
              project_id: "project-2",
              host_id: null,
              provisioned: false,
              owner_account_id: ACCOUNT_ID,
              usage_account_id: null,
              course: null,
            },
          ],
        };
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
      throw new Error(`unexpected query: ${sql}`);
    });
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { usage_limits: { max_projects: 2 } },
    }));
    const createProject = (await import("./create")).default;
    await expect(
      createProject({
        title: "Blocked",
        description: "",
        account_id: ACCOUNT_ID,
        start: false,
      }),
    ).rejects.toThrow("project limit reached (2/2)");
  });

  it("blocks clone creation when the owner already reached the hard total storage cap", async () => {
    getMembershipUsageStatusForAccountMock = jest.fn(async () => ({
      total_storage_bytes: 100,
    }));
    peekCachedMembershipUsageStatusForAccountMock = jest.fn(() => ({
      total_storage_bytes: 100,
    }));
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { usage_limits: { total_storage_hard_bytes: 100 } },
    }));
    const createProject = (await import("./create")).default;
    await expect(
      createProject({
        title: "Blocked clone",
        description: "",
        account_id: ACCOUNT_ID,
        src_project_id: SOURCE_PROJECT_ID,
        start: false,
      }),
    ).rejects.toThrow("total account storage hard cap reached");
  });

  it("blocks project creation when the owner already reached the soft total storage cap", async () => {
    getMembershipUsageStatusForAccountMock = jest.fn(async () => ({
      total_storage_bytes: 100,
    }));
    peekCachedMembershipUsageStatusForAccountMock = jest.fn(() => ({
      total_storage_bytes: 100,
    }));
    resolveMembershipForAccountMock = jest.fn(async () => ({
      entitlements: { usage_limits: { total_storage_soft_bytes: 100 } },
    }));
    const createProject = (await import("./create")).default;
    await expect(
      createProject({
        title: "Blocked project",
        description: "",
        account_id: ACCOUNT_ID,
        start: false,
      }),
    ).rejects.toThrow("total account storage soft cap reached");
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
        rootfs_image: "cocalc.local/rootfs/base",
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
      if (isRootfsScanSelectionQuery(sql)) {
        return rootfsScanAllowedRows({ image_id: "official-cocalc-base" });
      }
      if (
        sql.includes("SELECT release_id") &&
        sql.includes("FROM rootfs_images")
      ) {
        expect(params).toEqual(["cocalc.local/rootfs/base"]);
        return { rows: [{ release_id: "release-base" }] };
      }
      if (
        sql.includes("SELECT release_id") &&
        sql.includes("FROM rootfs_releases")
      ) {
        expect(params).toEqual(["cocalc.local/rootfs/base"]);
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
              runtime_image: "cocalc.local/rootfs/base",
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
      rootfs_image: "cocalc.local/rootfs/base",
      start: false,
    });

    expect(typeof project_id).toBe("string");
    expect(resolveHostBayMock).toHaveBeenCalledWith(HOST_ID);
    expect(hostConnectionGetMock).toHaveBeenCalledTimes(1);
    expect(hostControlCreateProjectMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      host_id: HOST_ID,
      create: {
        image: "cocalc.local/rootfs/base",
        project_id,
        start: false,
        title: "Remote host placement",
        users: { [ACCOUNT_ID]: { group: "owner" } },
      },
    });
  });
});
