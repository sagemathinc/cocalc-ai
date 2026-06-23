export {};

let getLocalProjectCollaboratorAccessStatusMock: jest.Mock;
let isAdminMock: jest.Mock;
let getPoolMock: jest.Mock;
let queryMock: jest.Mock;
let assertCollabAllowRemoteProjectAccessMock: jest.Mock;
let getAssignedProjectHostInfoMock: jest.Mock;
let getRoutedHostControlClientMock: jest.Mock;
let createLroMock: jest.Mock;
let getLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
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

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
  getLro: (...args: any[]) => getLroMock(...args),
  updateLro: (...args: any[]) => updateLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
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
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("project_rootfs_builds")) {
        if (sql.includes("SELECT *")) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO")) {
          return {
            rows: [
              {
                build_id: params?.[0],
                project_id: params?.[1],
                account_id: params?.[2],
                host_id: params?.[3],
                op_id: params?.[4],
                status: params?.[5],
                recipe_ref: params?.[6],
                paths: params?.[7],
                pid: params?.[8],
                exit_code: params?.[9],
                signal: params?.[10],
                error: params?.[11],
                created_at: params?.[12],
                started_at: params?.[13],
                finished_at: params?.[14],
                heartbeat_at: params?.[15],
                last_output_at: params?.[16],
                updated: new Date("2026-06-22T00:00:01.000Z"),
              },
            ],
          };
        }
        return { rows: [] };
      }
      return {
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
      };
    });
    getPoolMock = jest.fn(() => ({ query: queryMock }));
    createLroMock = jest.fn(async ({ build_id }) => ({
      op_id: "33333333-3333-4333-8333-333333333333",
      kind: "project-rootfs-build",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "queued",
      created_by: ACCOUNT_ID,
      owner_type: "host",
      owner_id: "host-1",
      routing: "project-host",
      input: { build_id },
      result: {},
      error: null,
      progress_summary: {},
      attempt: 0,
      heartbeat_at: null,
      created_at: new Date("2026-06-22T00:00:00.000Z"),
      started_at: null,
      finished_at: null,
      dismissed_at: null,
      dismissed_by: null,
      updated_at: new Date("2026-06-22T00:00:00.000Z"),
      expires_at: new Date("2026-07-06T00:00:00.000Z"),
      dedupe_key: null,
      parent_id: null,
    }));
    getLroMock = jest.fn(async () => ({
      op_id: "44444444-4444-4444-8444-444444444444",
      kind: "project-rootfs-publish",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status: "succeeded",
      created_by: ACCOUNT_ID,
      owner_type: null,
      owner_id: null,
      routing: "hub",
      input: {},
      result: { image_id: "published-rootfs" },
      error: null,
      progress_summary: {},
      attempt: 0,
      heartbeat_at: null,
      created_at: new Date("2026-06-22T00:00:00.000Z"),
      started_at: new Date("2026-06-22T00:00:01.000Z"),
      finished_at: new Date("2026-06-22T00:00:10.000Z"),
      dismissed_at: null,
      dismissed_by: null,
      updated_at: new Date("2026-06-22T00:00:10.000Z"),
      expires_at: new Date("2026-07-06T00:00:00.000Z"),
      dedupe_key: null,
      parent_id: null,
    }));
    updateLroMock = jest.fn(async ({ op_id, status }) => ({
      op_id,
      kind: "project-rootfs-build",
      scope_type: "project",
      scope_id: PROJECT_ID,
      status,
      created_by: ACCOUNT_ID,
      owner_type: "host",
      owner_id: "host-1",
      routing: "project-host",
      input: {},
      result: {},
      error: null,
      progress_summary: {},
      attempt: 0,
      heartbeat_at: null,
      created_at: new Date("2026-06-22T00:00:00.000Z"),
      started_at: null,
      finished_at: null,
      dismissed_at: null,
      dismissed_by: null,
      updated_at: new Date("2026-06-22T00:00:01.000Z"),
      expires_at: new Date("2026-07-06T00:00:00.000Z"),
      dedupe_key: null,
      parent_id: null,
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
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

  it("creates a project-scoped LRO and indexes rootfs build starts", async () => {
    const { startProjectRootfsBuild } = await import("./projects");
    const result = await startProjectRootfsBuild({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      build_id: "build-1",
      recipe_ref: "cocalc/julia",
      script: "echo hi",
    });

    expect(result).toMatchObject({
      build_id: "build-1",
      project_id: PROJECT_ID,
      host_id: "host-1",
      op_id: "33333333-3333-4333-8333-333333333333",
      status: "running",
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-rootfs-build",
        scope_type: "project",
        scope_id: PROJECT_ID,
        created_by: ACCOUNT_ID,
        owner_type: "host",
        owner_id: "host-1",
        routing: "project-host",
        status: "queued",
      }),
    );
    expect(hostControlClientMock.startRootfsBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT_ID,
        build_id: "build-1",
        recipe_ref: "cocalc/julia",
      }),
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO project_rootfs_builds"),
      expect.arrayContaining([
        "build-1",
        PROJECT_ID,
        ACCOUNT_ID,
        "host-1",
        "33333333-3333-4333-8333-333333333333",
        "running",
      ]),
    );
    expect(updateLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "33333333-3333-4333-8333-333333333333",
        status: "running",
      }),
    );
  });

  it("lists rootfs builds from the hub index", async () => {
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("project_rootfs_builds") && sql.includes("SELECT *")) {
        return {
          rows: [
            {
              build_id: "build-1",
              project_id: PROJECT_ID,
              account_id: ACCOUNT_ID,
              host_id: "host-1",
              op_id: "33333333-3333-4333-8333-333333333333",
              status: "succeeded",
              recipe_ref: "cocalc/julia",
              paths: {
                dir: ".cocalc/rootfs-builds/build-1",
                script: ".cocalc/rootfs-builds/build-1/run.sh",
                log: ".cocalc/rootfs-builds/build-1/build.log",
                status: ".cocalc/rootfs-builds/build-1/status.json",
                events: ".cocalc/rootfs-builds/build-1/events.ndjson",
              },
              created_at: new Date("2026-06-22T00:00:00.000Z"),
              finished_at: new Date("2026-06-22T00:00:10.000Z"),
              updated: new Date("2026-06-22T00:00:10.000Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });
    getPoolMock = jest.fn(() => ({ query: queryMock }));

    const { listProjectRootfsBuilds } = await import("./projects");
    await expect(
      listProjectRootfsBuilds({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        build_id: "build-1",
        project_id: PROJECT_ID,
        host_id: "host-1",
        op_id: "33333333-3333-4333-8333-333333333333",
        status: "succeeded",
        recipe_ref: "cocalc/julia",
      }),
    ]);
    expect(assertCollabAllowRemoteProjectAccessMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(getRoutedHostControlClientMock).not.toHaveBeenCalled();
  });

  it("records a verified project rootfs publish LRO on a successful build", async () => {
    queryMock = jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes("project_rootfs_builds") && sql.includes("SELECT *")) {
        return {
          rows: [
            {
              build_id: "build-1",
              project_id: PROJECT_ID,
              account_id: ACCOUNT_ID,
              host_id: "host-1",
              op_id: "33333333-3333-4333-8333-333333333333",
              status: "succeeded",
              recipe_ref: "cocalc/julia",
              paths: {},
              created_at: new Date("2026-06-22T00:00:00.000Z"),
              updated: new Date("2026-06-22T00:00:10.000Z"),
            },
          ],
        };
      }
      if (
        sql.includes("project_rootfs_builds") &&
        sql.includes("UPDATE project_rootfs_builds")
      ) {
        return {
          rows: [
            {
              build_id: params?.[1],
              project_id: params?.[0],
              account_id: ACCOUNT_ID,
              host_id: "host-1",
              op_id: "33333333-3333-4333-8333-333333333333",
              publish_op_id: params?.[2],
              publish_status: params?.[3],
              publish_image_id: params?.[4],
              publish_error: params?.[5],
              publish_started_at: params?.[6],
              publish_finished_at: params?.[7],
              status: "succeeded",
              recipe_ref: "cocalc/julia",
              paths: {},
              created_at: new Date("2026-06-22T00:00:00.000Z"),
              updated: new Date("2026-06-22T00:00:10.000Z"),
            },
          ],
        };
      }
      return { rows: [] };
    });
    getPoolMock = jest.fn(() => ({ query: queryMock }));

    const { recordProjectRootfsBuildPublish } = await import("./projects");
    await expect(
      recordProjectRootfsBuildPublish({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        build_id: "build-1",
        publish_op_id: "44444444-4444-4444-8444-444444444444",
      }),
    ).resolves.toMatchObject({
      build: {
        build_id: "build-1",
        project_id: PROJECT_ID,
        publish_op_id: "44444444-4444-4444-8444-444444444444",
        publish_status: "succeeded",
        publish_image_id: "published-rootfs",
      },
      publish: {
        op_id: "44444444-4444-4444-8444-444444444444",
        scope_type: "project",
        scope_id: PROJECT_ID,
      },
    });
    expect(getLroMock).toHaveBeenCalledWith(
      "44444444-4444-4444-8444-444444444444",
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE project_rootfs_builds"),
      expect.arrayContaining([
        PROJECT_ID,
        "build-1",
        "44444444-4444-4444-8444-444444444444",
        "succeeded",
        "published-rootfs",
      ]),
    );
  });
});
