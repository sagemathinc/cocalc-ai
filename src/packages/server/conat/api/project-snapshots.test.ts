export {};

let assertCollabMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let assertProjectOwnerCanIncreaseAccountStorageMock: jest.Mock;

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
}));

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
    getProjectFileServerClientMock = jest.fn(async () => ({
      createSnapshot: jest.fn(),
      deleteSnapshot: jest.fn(),
      updateSnapshots: jest.fn(),
      allSnapshotUsage: jest.fn(async () => []),
      getSnapshotFileText: jest.fn(),
    }));
  });

  it("creates a project-restore LRO for snapshot restore", async () => {
    const { restoreSnapshot } = await import("./project-snapshots");
    const result = await restoreSnapshot({
      account_id: "acct-1",
      project_id: "proj-1",
      snapshot: "before-upgrade",
      mode: "rootfs",
      safety_snapshot_name: "restore-safety",
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "proj-1",
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
