export {};

let assertCollabMock: jest.Mock;
let assertPortableProjectRootfsMock: jest.Mock;
let createLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let triggerBackupLroWorkerMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;

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

jest.mock("./util", () => ({
  __esModule: true,
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/projects/rootfs-state", () => ({
  __esModule: true,
  assertPortableProjectRootfs: (...args: any[]) =>
    assertPortableProjectRootfsMock(...args),
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

jest.mock("@cocalc/server/projects/backup-worker", () => ({
  __esModule: true,
  triggerBackupLroWorker: (...args: any[]) =>
    triggerBackupLroWorkerMock(...args),
}));

jest.mock("@cocalc/server/conat/file-server-client", () => ({
  __esModule: true,
  getProjectFileServerClient: (...args: any[]) =>
    getProjectFileServerClientMock(...args),
}));

describe("project-backups.createBackup", () => {
  beforeEach(() => {
    jest.resetModules();
    assertCollabMock = jest.fn(async () => undefined);
    assertPortableProjectRootfsMock = jest.fn(async () => undefined);
    createLroMock = jest.fn(async () => ({
      op_id: "op-backup-1",
      kind: "project-backup",
      scope_type: "project",
      scope_id: "proj-1",
      status: "queued",
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    triggerBackupLroWorkerMock = jest.fn();
    getProjectFileServerClientMock = jest.fn(async () => ({
      deleteBackup: jest.fn(),
      updateBackups: jest.fn(),
    }));
  });

  it("blocks queued backups for unsealed OCI-backed projects", async () => {
    assertPortableProjectRootfsMock.mockRejectedValue(
      new Error(
        "cannot backup project while its RootFS is still backed by unsealed OCI image 'docker.io/ubuntu:26.04'",
      ),
    );
    const { createBackup } = await import("./project-backups");

    await expect(
      createBackup({
        account_id: "acct-1",
        project_id: "proj-1",
      }),
    ).rejects.toThrow(/unsealed OCI image/);

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "proj-1",
    });
    expect(assertPortableProjectRootfsMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      operation: "backup",
    });
    expect(createLroMock).not.toHaveBeenCalled();
    expect(triggerBackupLroWorkerMock).not.toHaveBeenCalled();
  });

  it("allows trusted internal callers to bypass the portability guard", async () => {
    const { createBackup } = await import("./project-backups");

    const result = await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      { skip_rootfs_portability_check: true },
    );

    expect(assertPortableProjectRootfsMock).not.toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-backup",
        scope_type: "project",
        scope_id: "proj-1",
      }),
    );
    expect(result).toEqual({
      op_id: "op-backup-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "stream:op-backup-1",
    });
  });
});
