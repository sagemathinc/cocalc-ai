export {};

let assertCollabMock: jest.Mock;
let assertPortableProjectRootfsMock: jest.Mock;
let createLroMock: jest.Mock;
let updateLroMock: jest.Mock;
let publishLroSummaryMock: jest.Mock;
let publishLroEventMock: jest.Mock;
let triggerBackupLroWorkerMock: jest.Mock;
let getProjectFileServerClientMock: jest.Mock;
let resolveProjectBayMock: jest.Mock;
let getConfiguredBayIdMock: jest.Mock;
let projectControlBackupMock: jest.Mock;
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
  updateLro: (...args: any[]) => updateLroMock(...args),
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

jest.mock("@cocalc/server/inter-bay/directory", () => ({
  __esModule: true,
  resolveProjectBay: (...args: any[]) => resolveProjectBayMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: (...args: any[]) => getConfiguredBayIdMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/bridge", () => ({
  __esModule: true,
  getInterBayBridge: jest.fn(() => ({
    projectControl: jest.fn(() => ({
      backup: (...args: any[]) => projectControlBackupMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  assertProjectOwnerCanIncreaseAccountStorage: (...args: any[]) =>
    assertProjectOwnerCanIncreaseAccountStorageMock(...args),
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
    updateLroMock = jest.fn(async ({ op_id, status, result, error }) => ({
      op_id,
      kind: "project-backup",
      scope_type: "project",
      scope_id: "proj-1",
      status,
      result,
      error,
    }));
    publishLroSummaryMock = jest.fn(async () => undefined);
    publishLroEventMock = jest.fn(async () => undefined);
    triggerBackupLroWorkerMock = jest.fn();
    getProjectFileServerClientMock = jest.fn(async () => ({
      deleteBackup: jest.fn(),
      updateBackups: jest.fn(),
    }));
    resolveProjectBayMock = jest.fn(async () => ({
      bay_id: "bay-0",
      epoch: 0,
    }));
    getConfiguredBayIdMock = jest.fn(() => "bay-0");
    assertProjectOwnerCanIncreaseAccountStorageMock = jest.fn(
      async () => undefined,
    );
    projectControlBackupMock = jest.fn(async () => ({
      op_id: "remote-op-1",
      kind: "project-backup",
      scope_type: "project",
      scope_id: "proj-1",
      status: "succeeded",
      result: { id: "backup-1" },
      error: null,
      progress_summary: { phase: "done" },
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

  it("returns a local waitable LRO and delegates execution for remote-owner projects", async () => {
    resolveProjectBayMock.mockResolvedValue({ bay_id: "bay-1", epoch: 7 });
    const { createBackup } = await import("./project-backups");

    const result = await createBackup({
      account_id: "acct-1",
      project_id: "proj-1",
      tags: ["manual"],
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(assertPortableProjectRootfsMock).not.toHaveBeenCalled();
    expect(triggerBackupLroWorkerMock).not.toHaveBeenCalled();
    expect(projectControlBackupMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      account_id: "acct-1",
      tags: ["manual"],
      epoch: 7,
    });
    expect(updateLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        op_id: "op-backup-1",
        status: "succeeded",
        result: { id: "backup-1" },
        error: null,
        progress_summary: { phase: "done" },
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

describe("project-backups.restoreBackup", () => {
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
  });

  it("checks owner storage headroom before queuing a backup restore", async () => {
    const { restoreBackup } = await import("./project-backups");

    const result = await restoreBackup({
      account_id: "acct-1",
      project_id: "proj-1",
      id: "backup-1",
      path: "data/results",
      dest: "restored/results",
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
        input: {
          project_id: "proj-1",
          id: "backup-1",
          path: "data/results",
          dest: "restored/results",
        },
      }),
    );
    expect(result).toEqual({
      op_id: "op-restore-1",
      scope_type: "project",
      scope_id: "proj-1",
      service: "persist-service",
      stream_name: "stream:op-restore-1",
    });
  });
});
