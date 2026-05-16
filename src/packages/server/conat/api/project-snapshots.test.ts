export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let assertProjectOwnerCanIncreaseAccountStorageMock: jest.Mock;
let getProjectSnapshotLimitMock: jest.Mock;
let requireDangerousProjectMutationAuthMock: jest.Mock;
let poolQueryMock: jest.Mock;

jest.mock("@cocalc/backend/logger", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
  getLogger: jest.fn(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  __esModule: true,
  createLro: (...args: any[]) => createLroMock(...args),
}));

jest.mock("@cocalc/server/lro/stream", () => ({
  __esModule: true,
  publishLroEvent: (...args: any[]) => publishLroEventMock(...args),
  publishLroSummary: (...args: any[]) => publishLroSummaryMock(...args),
}));

jest.mock("@cocalc/conat/lro/names", () => ({
  __esModule: true,
  lroStreamName: jest.fn((op_id: string) => `stream:${op_id}`),
}));

jest.mock("@cocalc/conat/persist/util", () => ({
  __esModule: true,
  SERVICE: "persist-service",
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
}));

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  assertProjectOwnerCanIncreaseAccountStorage: (...args: any[]) =>
    assertProjectOwnerCanIncreaseAccountStorageMock(...args),
  getProjectSnapshotLimit: (...args: any[]) =>
    getProjectSnapshotLimitMock(...args),
}));

jest.mock("./project-dangerous-auth", () => ({
  __esModule: true,
  PROJECT_DANGEROUS_INTERNAL_AUTH: Symbol("project-dangerous-internal-auth"),
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireDangerousProjectMutationAuthMock(...args),
}));

describe("project-snapshots.createSnapshot", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    getProjectSnapshotLimitMock = jest.fn(async () => 8);
    poolQueryMock = jest.fn(async () => ({
      rows: [
        {
          snapshots: {
            frequent: 1,
            daily: 1,
            weekly: 0,
            monthly: 0,
          },
        },
      ],
    }));
    getProjectFileServerClientMock = jest.fn(async () => ({
      createSnapshot: jest.fn(),
      deleteSnapshot: jest.fn(),
      updateSnapshots: jest.fn(),
      allSnapshotUsage: jest.fn(async () => []),
      getSnapshotFileText: jest.fn(),
    }));
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
  });

  it("uses the project owner snapshot cap when creating a snapshot", async () => {
    const { createSnapshot, getSnapshotQuota } =
      await import("./project-snapshots");
    await createSnapshot({
      account_id: "acct-1",
      project_id: "proj-1",
      name: "manual-1",
    });
    const client = await getProjectFileServerClientMock.mock.results[0].value;
    expect(getProjectSnapshotLimitMock).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(client.createSnapshot).toHaveBeenCalledWith({
      project_id: "proj-1",
      name: "manual-1",
      limit: 8,
    });
    await expect(
      getSnapshotQuota({ account_id: "acct-1", project_id: "proj-1" }),
    ).resolves.toEqual({
      limit: 8,
      manual: {
        limit: 6,
        current: 0,
        rolling_reserved: 2,
      },
    });
  });

  it("blocks manual snapshot creation when named snapshots fill manual slots", async () => {
    getProjectFileServerClientMock = jest.fn(async () => ({
      createSnapshot: jest.fn(),
      deleteSnapshot: jest.fn(),
      updateSnapshots: jest.fn(),
      allSnapshotUsage: jest.fn(async () => [
        { name: "manual-1" },
        { name: "manual-2" },
      ]),
      getSnapshotFileText: jest.fn(),
    }));
    getProjectSnapshotLimitMock = jest.fn(async () => 3);
    const { createSnapshot } = await import("./project-snapshots");
    await expect(
      createSnapshot({
        account_id: "acct-1",
        project_id: "proj-1",
        name: "manual-3",
      }),
    ).rejects.toThrow("Manual snapshot limit reached");
    const client = await getProjectFileServerClientMock.mock.results[0].value;
    expect(client.createSnapshot).not.toHaveBeenCalled();
  });
});

describe("project-snapshots.restoreSnapshot", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-restore-1",
      kind: "project-restore",
      scope_type: "project",
      scope_id: "proj-1",
      status: "queued",
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    assertProjectOwnerCanIncreaseAccountStorageMock = jest.fn(
      async () => undefined,
    );
    getProjectSnapshotLimitMock = jest.fn(async () => 8);
    getProjectFileServerClientMock = jest.fn(async () => ({
      createSnapshot: jest.fn(),
      deleteSnapshot: jest.fn(),
      updateSnapshots: jest.fn(),
      allSnapshotUsage: jest.fn(async () => []),
      getSnapshotFileText: jest.fn(),
    }));
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
  });

  it("creates a project-restore LRO for snapshot restore", async () => {
    const { restoreSnapshot } = await import("./project-snapshots");
    const result = await restoreSnapshot({
      account_id: "acct-1",
      session_hash: "session-1",
      project_id: "proj-1",
      snapshot: "before-upgrade",
      mode: "rootfs",
      safety_snapshot_name: "restore-safety",
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "proj-1",
    });
    expect(requireDangerousProjectMutationAuthMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      session_hash: "session-1",
    });
    expect(
      assertProjectOwnerCanIncreaseAccountStorageMock,
    ).toHaveBeenCalledWith({
      project_id: "proj-1",
    });
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-restore",
        scope_type: "project",
        scope_id: "proj-1",
        created_by: "acct-1",
        routing: "hub",
        status: "queued",
        input: {
          project_id: "proj-1",
          restore_type: "snapshot",
          snapshot: "before-upgrade",
          mode: "rootfs",
          safety_snapshot_name: "restore-safety",
        },
      }),
    );
    expect(publishLroSummaryMock).toHaveBeenCalledTimes(1);
    expect(publishLroEventMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      op_id: "op-restore-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "stream:op-restore-1",
    });
  });
});
