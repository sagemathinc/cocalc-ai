export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let assertCollabAllowRemoteProjectAccessMock: jest.Mock;
let getAssignedProjectHostInfoMock: jest.Mock;
let getRoutedHostControlClientMock: jest.Mock;
let hostControlClientMock: {
  startRootfsBuild: jest.Mock;
  getRootfsBuildStatus: jest.Mock;
  getRootfsBuildLog: jest.Mock;
  cancelRootfsBuild: jest.Mock;
};

jest.mock("@cocalc/server/conat/project-local-access", () => ({
  __esModule: true,
  PROJECT_COLLABORATOR_REQUIRED_ERROR: "user must be a collaborator on project",
  PROJECT_NOT_FOUND_ERROR: "project not found",
  getLocalProjectCollaboratorAccessStatus: (...args: any[]) =>
    getLocalProjectCollaboratorAccessStatusMock(...args),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: (...args: any[]) => isAdminMock(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => getPoolMock(...args),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: jest.fn(),
  assertCollabAllowRemoteProjectAccess: (...args: any[]) =>
    assertCollabAllowRemoteProjectAccessMock(...args),
}));

jest.mock("@cocalc/server/conat/project-host-assignment", () => ({
  __esModule: true,
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR: "project has no assigned host",
  getAssignedProjectHostInfo: (...args: any[]) =>
    getAssignedProjectHostInfoMock(...args),
}));

jest.mock("@cocalc/server/project-host/client", () => ({
  __esModule: true,
  getRoutedHostControlClient: (...args: any[]) =>
    getRoutedHostControlClientMock(...args),
}));

describe("project rootfs helpers", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
  const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertCollabAllowRemoteProjectAccessMock = jest.fn(async () => undefined);
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "local-collaborator",
    );
    isAdminMock = jest.fn(async () => false);
    queryMock = jest.fn(async () => ({
      rows: [
        {
          region: null,
          created: null,
          env: null,
          rootfs_image: "buildpack-deps:noble-scm",
          rootfs_image_id: "official-cocalc-base",
          snapshots: null,
          backups: null,
          run_quota: null,
          settings: null,
          course: null,
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    getAssignedProjectHostInfoMock = jest.fn(async () => ({
      host_id: "host-1",
      ssh_server: null,
      metadata: {},
    }));
    hostControlClientMock = {
      startRootfsBuild: jest.fn(async ({ project_id }) => ({
        build_id: "build-1",
        project_id,
        status: "running",
        created_at: "2026-06-22T00:00:00.000Z",
        paths: {
          dir: ".cocalc/rootfs-builds/build-1",
          script: ".cocalc/rootfs-builds/build-1/run.sh",
          log: ".cocalc/rootfs-builds/build-1/build.log",
          status: ".cocalc/rootfs-builds/build-1/status.json",
          events: ".cocalc/rootfs-builds/build-1/events.ndjson",
        },
      })),
      getRootfsBuildStatus: jest.fn(async ({ project_id, build_id }) => ({
        build_id,
        project_id,
        status: "succeeded",
        created_at: "2026-06-22T00:00:00.000Z",
        paths: {
          dir: ".cocalc/rootfs-builds/build-1",
          script: ".cocalc/rootfs-builds/build-1/run.sh",
          log: ".cocalc/rootfs-builds/build-1/build.log",
          status: ".cocalc/rootfs-builds/build-1/status.json",
          events: ".cocalc/rootfs-builds/build-1/events.ndjson",
        },
      })),
      getRootfsBuildLog: jest.fn(async ({ project_id, build_id }) => ({
        build_id,
        project_id,
        lines: 0,
        byte_offset: 100,
        next_byte_offset: 160,
        bytes: 60,
        eof: false,
        text: "log chunk",
        found: true,
        path: ".cocalc/rootfs-builds/build-1/build.log",
      })),
      cancelRootfsBuild: jest.fn(async ({ project_id, build_id }) => ({
        build_id,
        project_id,
        status: "canceling",
        signaled: true,
      })),
    };
    getRoutedHostControlClientMock = jest.fn(async () => hostControlClientMock);
  });

  it("returns project rootfs for a collaborator", async () => {
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      image: "buildpack-deps:noble-scm",
      image_id: "official-cocalc-base",
    });
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("SELECT"), [
      PROJECT_ID,
    ]);
  });

  it("allows admins to read project rootfs without collaborator access", async () => {
    getLocalProjectCollaboratorAccessStatusMock = jest.fn(
      async () => "not-collaborator",
    );
    isAdminMock = jest.fn(async () => true);
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual({
      image: "buildpack-deps:noble-scm",
      image_id: "official-cocalc-base",
    });
    expect(isAdminMock).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("returns null when the project has no configured rootfs image", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          region: null,
          created: null,
          env: null,
          rootfs_image: null,
          rootfs_image_id: null,
          snapshots: null,
          backups: null,
          run_quota: null,
          settings: null,
          course: null,
        },
      ],
    }));
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    const { getProjectRootfs } = await import("./projects");
    await expect(
      getProjectRootfs({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toBeNull();
  });

  it("routes project rootfs build log reads through the assigned project host", async () => {
    const { getProjectRootfsBuildLog } = await import("./projects");
    await expect(
      getProjectRootfsBuildLog({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        build_id: "build-1",
        byte_offset: 100,
        max_bytes: 4096,
      }),
    ).resolves.toMatchObject({
      host_id: "host-1",
      build_id: "build-1",
      project_id: PROJECT_ID,
      text: "log chunk",
      byte_offset: 100,
      next_byte_offset: 160,
    });
    expect(assertCollabAllowRemoteProjectAccessMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(getAssignedProjectHostInfoMock).toHaveBeenCalledWith(PROJECT_ID);
    expect(getRoutedHostControlClientMock).toHaveBeenCalledWith({
      host_id: "host-1",
      timeout: 30_000,
    });
    expect(hostControlClientMock.getRootfsBuildLog).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      build_id: "build-1",
      lines: undefined,
      byte_offset: 100,
      max_bytes: 4096,
    });
  });
});
