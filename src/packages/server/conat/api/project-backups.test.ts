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
let projectDetailsGetMock: jest.Mock;
let getProjectRecoveryStatusLocalMock: jest.Mock;
let assertProjectOwnerCanIncreaseAccountStorageMock: jest.Mock;
let getProjectBackupLimitMock: jest.Mock;
let getManagedProjectEgressPolicyMock: jest.Mock;
let requireDangerousProjectMutationAuthMock: jest.Mock;

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
    projectDetails: jest.fn(() => ({
      get: (...args: any[]) => projectDetailsGetMock(...args),
    })),
  })),
}));

jest.mock("@cocalc/server/projects/maintenance-status", () => ({
  __esModule: true,
  getProjectRecoveryStatusLocal: (...args: any[]) =>
    getProjectRecoveryStatusLocalMock(...args),
}));

jest.mock("@cocalc/server/membership/project-limits", () => ({
  __esModule: true,
  assertProjectOwnerCanIncreaseAccountStorage: (...args: any[]) =>
    assertProjectOwnerCanIncreaseAccountStorageMock(...args),
  getProjectBackupLimit: (...args: any[]) => getProjectBackupLimitMock(...args),
}));

jest.mock("@cocalc/server/membership/managed-egress-policy", () => ({
  __esModule: true,
  getManagedProjectEgressPolicy: (...args: any[]) =>
    getManagedProjectEgressPolicyMock(...args),
}));

jest.mock("./project-dangerous-auth", () => ({
  __esModule: true,
  PROJECT_DANGEROUS_INTERNAL_AUTH: Symbol("project-dangerous-internal-auth"),
  requireDangerousProjectMutationAuth: (...args: any[]) =>
    requireDangerousProjectMutationAuthMock(...args),
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
    getProjectBackupLimitMock = jest.fn(async () => 5);
    getManagedProjectEgressPolicyMock = jest.fn(async () => ({
      allowed: true,
      category: "backup-upload",
    }));
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
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
    projectDetailsGetMock = jest.fn(async () => ({
      recovery_status: { project_id: "proj-1", host_id: "host-remote" },
    }));
    getProjectRecoveryStatusLocalMock = jest.fn(async () => ({
      project_id: "proj-1",
      host_id: "host-local",
    }));
  });

  it("reads recovery status from the authoritative project bay", async () => {
    resolveProjectBayMock.mockResolvedValue({ bay_id: "bay-remote", epoch: 4 });
    const { getRecoveryStatus } = await import("./project-backups");
    await expect(
      getRecoveryStatus({ account_id: "acct-1", project_id: "proj-1" }),
    ).resolves.toMatchObject({ host_id: "host-remote" });
    expect(projectDetailsGetMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "proj-1",
      include_recovery_status: true,
    });
    expect(getProjectRecoveryStatusLocalMock).not.toHaveBeenCalled();
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

  it("blocks backup creation immediately when managed backup egress is already over limit", async () => {
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      category: "backup-upload",
      blocked_by: "7d",
      managed_egress_5h_bytes: 9_000_000,
      managed_egress_7d_bytes: 12_000_000,
      egress_5h_bytes: 8_000_000,
      egress_7d_bytes: 10_000_000,
      managed_egress_categories_5h_bytes: {
        "backup-upload": 7_000_000,
        "raw-network": 2_000_000,
      },
      managed_egress_categories_7d_bytes: {
        "backup-upload": 10_000_000,
        "raw-network": 2_000_000,
      },
    });
    const { createBackup } = await import("./project-backups");
    const onLroCreateStarted = jest.fn();

    await expect(
      createBackup(
        {
          account_id: "acct-1",
          project_id: "proj-1",
        },
        { on_lro_create_started: onLroCreateStarted },
      ),
    ).rejects.toThrow("Limit triggered by the 7-day network usage window.");

    expect(getManagedProjectEgressPolicyMock).toHaveBeenCalledWith({
      project_id: "proj-1",
      category: "backup-upload",
    });
    expect(onLroCreateStarted).not.toHaveBeenCalled();
    expect(createLroMock).not.toHaveBeenCalled();
    expect(triggerBackupLroWorkerMock).not.toHaveBeenCalled();
  });

  it("signals immediately before durable backup LRO creation", async () => {
    const { createBackup } = await import("./project-backups");
    const onLroCreateStarted = jest.fn();

    await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      { on_lro_create_started: onLroCreateStarted },
    );

    expect(onLroCreateStarted).toHaveBeenCalledTimes(1);
    expect(onLroCreateStarted.mock.invocationCallOrder[0]).toBeLessThan(
      createLroMock.mock.invocationCallOrder[0],
    );
  });

  it("allows the internal admin host drain override to bypass the managed egress preflight", async () => {
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      category: "backup-upload",
    });
    const { createBackup } = await import("./project-backups");

    const result = await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      { managed_egress_override: "admin-host-drain" },
    );

    expect(getManagedProjectEgressPolicyMock).not.toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          managed_egress_override: "admin-host-drain",
        }),
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

  it("allows the legacy migration initial backup override to bypass the managed egress preflight", async () => {
    getManagedProjectEgressPolicyMock.mockResolvedValue({
      allowed: false,
      category: "backup-upload",
    });
    const { createBackup } = await import("./project-backups");

    await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      { managed_egress_override: "legacy-migration-initial-backup" },
    );

    expect(getManagedProjectEgressPolicyMock).not.toHaveBeenCalled();
    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          managed_egress_override: "legacy-migration-initial-backup",
        }),
      }),
    );
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
        input: expect.objectContaining({
          project_id: "proj-1",
          tags: undefined,
          limit: 5,
          owning_bay_id: "bay-0",
        }),
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

  it("allows trusted internal callers to use a specific dedupe key", async () => {
    const { createBackup } = await import("./project-backups");

    await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      {
        skip_rootfs_portability_check: true,
        dedupe_key: "project-backup:move:proj-1:move-1:final",
      },
    );

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project-backup",
        scope_type: "project",
        scope_id: "proj-1",
        dedupe_key: "project-backup:move:proj-1:move-1:final",
      }),
    );
  });

  it("allows trusted internal callers to replace the oldest backup at quota", async () => {
    const { createBackup } = await import("./project-backups");

    await createBackup(
      {
        account_id: "acct-1",
        project_id: "proj-1",
      },
      {
        skip_rootfs_portability_check: true,
        replace_oldest_at_limit: true,
      },
    );

    expect(createLroMock).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          project_id: "proj-1",
          limit: 5,
          replace_oldest_at_limit: true,
        }),
      }),
    );
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

  it("returns the owner backup cap from getBackupQuota", async () => {
    const { getBackupQuota } = await import("./project-backups");
    await expect(
      getBackupQuota({ account_id: "acct-1", project_id: "proj-1" }),
    ).resolves.toEqual({ limit: 5 });
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
    requireDangerousProjectMutationAuthMock = jest.fn(async () => undefined);
  });

  it("checks owner storage headroom before queuing a backup restore", async () => {
    const { restoreBackup } = await import("./project-backups");

    const result = await restoreBackup({
      account_id: "acct-1",
      session_hash: "session-1",
      project_id: "proj-1",
      id: "backup-1",
      path: "data/results",
      dest: "restored/results",
    });

    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id: "proj-1",
    });
    expect(requireDangerousProjectMutationAuthMock).not.toHaveBeenCalled();
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
