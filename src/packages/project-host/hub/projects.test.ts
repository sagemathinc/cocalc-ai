import { hubApi } from "@cocalc/lite/hub/api";
import { DEFAULT_PROJECT_IMAGE } from "@cocalc/util/db-schema/defaults";

const executeCode = jest.fn(async () => ({
  stdout: "",
  stderr: "",
  exit_code: 0,
}));
const rehydrateAcpAutomationsForProject = jest.fn();
const applyPendingCopies = jest.fn();
const upsertProject = jest.fn();
const getProject = jest.fn();
const getOrCreateProjectLocalSecretToken = jest.fn();
const deleteProjectLocal = jest.fn();
const markProjectStateReported = jest.fn();
const reportProjectStateToMaster = jest.fn();
const writeManagedAuthorizedKeys = jest.fn();
const pullRootfsCacheEntry = jest.fn(async () => undefined);
const withOciPullReservationIfNeeded = jest.fn(
  async ({ fn }: { fn: () => Promise<any> }) => await fn(),
);
const prepareOciPullReservationEstimate = jest.fn(async () => undefined);
const readFile = jest.fn(async () => "");
const callHub = jest.fn();
const getLocalHostId = jest.fn(() => "host-1");
const getMasterConatClient = jest.fn();
const queueProjectProvisioned = jest.fn();
const fileServerCreateBackup = jest.fn();
const ensureVolume = jest.fn();
const ensureProjectVolumeIdentity = jest.fn();
const reconcileManagedProjectVolumeQuota = jest.fn();
const resetScratchVolume = jest.fn();
const deleteVolume = jest.fn();
const sandboxExec = jest.fn();
const getVolume = jest.fn(async () => ({ path: "/mnt/cocalc/project-test" }));
const resolveProjectContainerPath = jest.fn(async (_project_id, p) => p);
const getChatStoreStats = jest.fn();
const rotateChatStore = jest.fn();
const listChatStoreSegments = jest.fn();
const readChatStoreArchived = jest.fn();
const readChatStoreArchivedHit = jest.fn();
const searchChatStoreArchived = jest.fn();
const deleteChatStoreData = jest.fn();
const vacuumChatStore = jest.fn();
const upsertProjectStopState = jest.fn();
const hasRecentProjectBrowserActivity = jest.fn(() => false);
const assertManagedRawNetworkStartAllowedBestEffortMock = jest.fn();
const getCodexAppServerAccountStatus = jest.fn();
const resolveCodexAuthRuntime = jest.fn();
const getCodexSubscriptionIdentity = jest.fn();
const uploadSubscriptionAuthFile = jest.fn();
const ensureCodexAuthFileExists = jest.fn();
const ensureCodexCredentialsStoreFile = jest.fn();
const acquireProjectPortLease = jest.fn();
const coolDownProjectPortOffset = jest.fn();
const getCoolingProjectPortOffsets = jest.fn(() => new Set());
const getProjectPortLease = jest.fn();
const getProjectPortLeaseBySshPort = jest.fn();
const getProjectPortLeaseByHttpPort = jest.fn();
const projectPortOffsetFromSshPort = jest.fn();
const projectPortOffsetFromHttpPort = jest.fn();
const acceptProjectVolumeQuotaDesired = jest.fn();
const claimStoppedScratchVolumePreparations = jest.fn();
const markProjectVolumeQuotaApplied = jest.fn();
const markProjectVolumeQuotaApplying = jest.fn();
const markProjectVolumeQuotaFailed = jest.fn();
const markProjectVolumeQuotaResetComplete = jest.fn();
const projectVolumeQuotaIsApplied = jest.fn();
const getProjectVolumeQuota = jest.fn();
const invalidateProjectVolumeQuota = jest.fn();
const listStoppedScratchVolumePreparationBatch = jest.fn();
const currentProjectVolumeLifecycleGeneration = jest.fn(() => 0);
const getRecordedProjectVolumeIdentity = jest.fn();

jest.mock("@cocalc/lite/hub/api", () => ({ hubApi: { projects: {} as any } }));
jest.mock("@cocalc/backend/data", () => ({
  account_id: "test-account-id",
  data: "/tmp",
}));
jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCode(...args),
}));
jest.mock("@cocalc/backend/logger", () => {
  const factory = () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });
  return {
    __esModule: true,
    default: factory,
    getLogger: factory,
  };
});
jest.mock("@cocalc/project-proxy/ssh-server", () => ({
  secretsPath: () => "/tmp",
}));
jest.mock("@cocalc/file-server/btrfs/subvolume-snapshots", () => ({
  getGeneration: jest.fn(),
}));
jest.mock("node:fs/promises", () => ({
  readFile: (...args: any[]) => readFile(...args),
}));
jest.mock("../sqlite/projects", () => ({
  deleteProjectLocal: (...args: any[]) => deleteProjectLocal(...args),
  getProject: (...args: any[]) => getProject(...args),
  getOrCreateProjectLocalSecretToken: (...args: any[]) =>
    getOrCreateProjectLocalSecretToken(...args),
  markProjectStateReported: (...args: any[]) =>
    markProjectStateReported(...args),
  upsertProject: (...args: any[]) => upsertProject(...args),
}));
jest.mock("../sqlite/stop-policy", () => ({
  hasRecentProjectBrowserActivity: (...args: any[]) =>
    hasRecentProjectBrowserActivity(...args),
  upsertProjectStopState: (...args: any[]) => upsertProjectStopState(...args),
}));
jest.mock("../browser-runtime", () => ({
  browserIdleTimeoutSeconds: (run_quota: any) =>
    Number(run_quota?.browser_idle_timeout) || 0,
}));
jest.mock("../master-status", () => ({
  getMasterConatClient: (...args: any[]) => getMasterConatClient(...args),
  queueProjectProvisioned: (...args: any[]) => queueProjectProvisioned(...args),
  reportProjectStateToMaster: (...args: any[]) =>
    reportProjectStateToMaster(...args),
}));
jest.mock("../file-server", () => ({
  writeManagedAuthorizedKeys: (...args: any[]) =>
    writeManagedAuthorizedKeys(...args),
  getVolume: (...args: any[]) => getVolume(...args),
  ensureVolume: (...args: any[]) => ensureVolume(...args),
  ensureProjectVolumeIdentity: (...args: any[]) =>
    ensureProjectVolumeIdentity(...args),
  reconcileManagedProjectVolumeQuota: (...args: any[]) =>
    reconcileManagedProjectVolumeQuota(...args),
  resetScratchVolume: (...args: any[]) => resetScratchVolume(...args),
  deleteVolume: (...args: any[]) => deleteVolume(...args),
  getMountPoint: jest.fn(() => "/mnt/cocalc"),
  resolveProjectContainerPath: (...args: any[]) =>
    resolveProjectContainerPath(...args),
}));
jest.mock("@cocalc/project-runner/run/sandbox-exec", () => ({
  sandboxExec: (...args: any[]) => sandboxExec(...args),
}));
jest.mock("@cocalc/backend/chat-store/sqlite-offload", () => ({
  getChatStoreStats: (...args: any[]) => getChatStoreStats(...args),
  rotateChatStore: (...args: any[]) => rotateChatStore(...args),
  listChatStoreSegments: (...args: any[]) => listChatStoreSegments(...args),
  readChatStoreArchived: (...args: any[]) => readChatStoreArchived(...args),
  readChatStoreArchivedHit: (...args: any[]) =>
    readChatStoreArchivedHit(...args),
  searchChatStoreArchived: (...args: any[]) => searchChatStoreArchived(...args),
  deleteChatStoreData: (...args: any[]) => deleteChatStoreData(...args),
  vacuumChatStore: (...args: any[]) => vacuumChatStore(...args),
}));
jest.mock("../pending-copies", () => ({
  applyPendingCopies: (...args: any[]) => applyPendingCopies(...args),
}));
jest.mock("../rootfs-cache", () => ({
  pullRootfsCacheEntry: (...args: any[]) => pullRootfsCacheEntry(...args),
}));
jest.mock("@cocalc/lite/hub/acp", () => ({
  rehydrateAcpAutomationsForProject: (...args: any[]) =>
    rehydrateAcpAutomationsForProject(...args),
}));
jest.mock("../storage-reservations", () => ({
  prepareOciPullReservationEstimate: (...args: any[]) =>
    prepareOciPullReservationEstimate(...args),
  withOciPullReservationIfNeeded: (...args: any[]) =>
    withOciPullReservationIfNeeded(...args),
}));
jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => callHub(...args),
}));
jest.mock("../sqlite/hosts", () => ({
  getLocalHostId: (...args: any[]) => getLocalHostId(...args),
}));
jest.mock("../raw-network-egress", () => ({
  assertManagedRawNetworkStartAllowedBestEffort: (...args: any[]) =>
    assertManagedRawNetworkStartAllowedBestEffortMock(...args),
}));
jest.mock("@cocalc/ai/acp", () => ({
  getCodexAppServerAccountStatus: (...args: any[]) =>
    getCodexAppServerAccountStatus(...args),
}));
jest.mock("../codex/codex-auth", () => ({
  ensureCodexAuthFileExists: (...args: any[]) =>
    ensureCodexAuthFileExists(...args),
  ensureCodexCredentialsStoreFile: (...args: any[]) =>
    ensureCodexCredentialsStoreFile(...args),
  resolveCodexAuthRuntime: (...args: any[]) => resolveCodexAuthRuntime(...args),
  getCodexSubscriptionIdentity: (...args: any[]) =>
    getCodexSubscriptionIdentity(...args),
  resolveSubscriptionCodexHome: () => "/tmp/codex-home",
  subscriptionRuntime: (...args: any[]) => ({
    source: "subscription",
    contextId: "subscription-context",
    codexHome: args[0]?.codexHome,
    env: {},
  }),
  uploadSubscriptionAuthFile: (...args: any[]) =>
    uploadSubscriptionAuthFile(...args),
}));
jest.mock("../sqlite/port-leases", () => ({
  acquireProjectPortLease: (...args: any[]) => acquireProjectPortLease(...args),
  coolDownProjectPortOffset: (...args: any[]) =>
    coolDownProjectPortOffset(...args),
  getCoolingProjectPortOffsets: (...args: any[]) =>
    getCoolingProjectPortOffsets(...args),
  getProjectPortLease: (...args: any[]) => getProjectPortLease(...args),
  getProjectPortLeaseBySshPort: (...args: any[]) =>
    getProjectPortLeaseBySshPort(...args),
  getProjectPortLeaseByHttpPort: (...args: any[]) =>
    getProjectPortLeaseByHttpPort(...args),
  PROJECT_PORT_BIND_FAILURE_COOLDOWN_MS: 10 * 60_000,
  projectPortOffsetFromSshPort: (...args: any[]) =>
    projectPortOffsetFromSshPort(...args),
  projectPortOffsetFromHttpPort: (...args: any[]) =>
    projectPortOffsetFromHttpPort(...args),
}));
jest.mock("../sqlite/volume-quotas", () => ({
  acceptProjectVolumeQuotaDesired: (...args: any[]) =>
    acceptProjectVolumeQuotaDesired(...args),
  claimStoppedScratchVolumePreparations: (...args: any[]) =>
    claimStoppedScratchVolumePreparations(...args),
  getProjectVolumeQuota: (...args: any[]) => getProjectVolumeQuota(...args),
  invalidateProjectVolumeQuota: (...args: any[]) =>
    invalidateProjectVolumeQuota(...args),
  listStoppedScratchVolumePreparationBatch: (...args: any[]) =>
    listStoppedScratchVolumePreparationBatch(...args),
  markProjectVolumeQuotaApplied: (...args: any[]) =>
    markProjectVolumeQuotaApplied(...args),
  markProjectVolumeQuotaApplying: (...args: any[]) =>
    markProjectVolumeQuotaApplying(...args),
  markProjectVolumeQuotaFailed: (...args: any[]) =>
    markProjectVolumeQuotaFailed(...args),
  markProjectVolumeQuotaResetComplete: (...args: any[]) =>
    markProjectVolumeQuotaResetComplete(...args),
  projectVolumeQuotaIsApplied: (...args: any[]) =>
    projectVolumeQuotaIsApplied(...args),
}));
jest.mock("../sqlite/project-volumes", () => ({
  getRecordedProjectVolumeIdentity: (...args: any[]) =>
    getRecordedProjectVolumeIdentity(...args),
}));
jest.mock("../sqlite/volume-quota-overrides", () => ({
  effectiveProjectVolumeQuotaBytes: ({
    persistent_bytes,
  }: {
    persistent_bytes: number;
  }) => ({
    effective_bytes: persistent_bytes,
    overrides: [],
  }),
}));
jest.mock("../project-volume-lifecycle", () => ({
  currentProjectVolumeLifecycleGeneration: (...args: any[]) =>
    currentProjectVolumeLifecycleGeneration(...args),
}));
jest.mock("@cocalc/conat/files/file-server", () => ({
  __esModule: true,
  client: jest.fn(() => ({
    createBackup: (...args: any[]) => fileServerCreateBackup(...args),
    deleteBackup: jest.fn(),
    restoreBackup: jest.fn(),
    beginRestoreStaging: jest.fn(),
    ensureRestoreStaging: jest.fn(),
    finalizeRestoreStaging: jest.fn(),
    releaseRestoreStaging: jest.fn(),
    cleanupRestoreStaging: jest.fn(),
    getBackups: jest.fn(),
    getBackupFiles: jest.fn(),
    getSnapshotFileText: jest.fn(),
  })),
}));

describe("project host start ACP rehydrate ordering", () => {
  const project_id = "3f5d0b28-cf69-4c78-9b0a-ea747bc7acb3";
  const customImage = "ghcr.io/example/custom-rootfs:2026-03-21";
  const flushMicrotasks = async () => {
    for (let i = 0; i < 40; i++) {
      await Promise.resolve();
    }
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const {
      resetCodexModelCatalogCacheForTesting,
      resetPortBindStateForTesting,
    } = await import("./projects");
    resetPortBindStateForTesting();
    resetCodexModelCatalogCacheForTesting();
    (hubApi.projects as any) = {};
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: undefined,
    });
    getOrCreateProjectLocalSecretToken.mockReturnValue("secret");
    applyPendingCopies.mockResolvedValue(undefined);
    writeManagedAuthorizedKeys.mockResolvedValue(undefined);
    ensureProjectVolumeIdentity.mockReset();
    ensureProjectVolumeIdentity.mockResolvedValue("volume-identity");
    reconcileManagedProjectVolumeQuota.mockReset();
    reconcileManagedProjectVolumeQuota.mockResolvedValue(10_000_000_000);
    resetScratchVolume.mockReset();
    pullRootfsCacheEntry.mockResolvedValue(undefined);
    prepareOciPullReservationEstimate.mockResolvedValue(undefined);
    withOciPullReservationIfNeeded.mockImplementation(
      async ({ fn }: { fn: () => Promise<any> }) => await fn(),
    );
    readFile.mockResolvedValue("");
    callHub.mockReset();
    fileServerCreateBackup.mockReset();
    getMasterConatClient.mockReturnValue(undefined);
    queueProjectProvisioned.mockReset();
    resolveProjectContainerPath.mockImplementation(
      async (_project_id: string, p: string) => `/projects/host${p}`,
    );
    getChatStoreStats.mockReset();
    rotateChatStore.mockReset();
    listChatStoreSegments.mockReset();
    readChatStoreArchived.mockReset();
    readChatStoreArchivedHit.mockReset();
    searchChatStoreArchived.mockReset();
    deleteChatStoreData.mockReset();
    vacuumChatStore.mockReset();
    upsertProjectStopState.mockReset();
    hasRecentProjectBrowserActivity.mockReset();
    hasRecentProjectBrowserActivity.mockReturnValue(false);
    assertManagedRawNetworkStartAllowedBestEffortMock.mockReset();
    getCodexAppServerAccountStatus.mockReset();
    resolveCodexAuthRuntime.mockReset();
    getCodexSubscriptionIdentity.mockReset();
    uploadSubscriptionAuthFile.mockReset();
    ensureCodexAuthFileExists.mockReset();
    ensureCodexCredentialsStoreFile.mockReset();
    assertManagedRawNetworkStartAllowedBestEffortMock.mockResolvedValue(
      undefined,
    );
    acquireProjectPortLease.mockReset();
    getProjectPortLease.mockReset();
    getProjectPortLeaseBySshPort.mockReset();
    getProjectPortLeaseByHttpPort.mockReset();
    coolDownProjectPortOffset.mockReset();
    getCoolingProjectPortOffsets.mockReset();
    getCoolingProjectPortOffsets.mockReturnValue(new Set());
    acceptProjectVolumeQuotaDesired.mockReset();
    claimStoppedScratchVolumePreparations.mockReset();
    claimStoppedScratchVolumePreparations.mockReturnValue(0);
    acceptProjectVolumeQuotaDesired.mockImplementation(
      ({ project_id, volume_kind, desired_bytes, desired_revision = 0 }) => ({
        status: "accepted",
        row: {
          project_id,
          volume_kind,
          desired_bytes,
          desired_revision,
          state: "pending",
        },
      }),
    );
    markProjectVolumeQuotaApplied.mockReset();
    markProjectVolumeQuotaApplying.mockReset();
    markProjectVolumeQuotaFailed.mockReset();
    markProjectVolumeQuotaResetComplete.mockReset();
    markProjectVolumeQuotaResetComplete.mockReturnValue(true);
    projectVolumeQuotaIsApplied.mockReset();
    projectVolumeQuotaIsApplied.mockReturnValue(false);
    getProjectVolumeQuota.mockReset();
    invalidateProjectVolumeQuota.mockReset();
    listStoppedScratchVolumePreparationBatch.mockReset();
    listStoppedScratchVolumePreparationBatch.mockReturnValue([]);
    currentProjectVolumeLifecycleGeneration.mockReset();
    currentProjectVolumeLifecycleGeneration.mockReturnValue(0);
    getRecordedProjectVolumeIdentity.mockReset();
    getRecordedProjectVolumeIdentity.mockReturnValue("volume-identity");
    projectPortOffsetFromSshPort.mockReset();
    projectPortOffsetFromHttpPort.mockReset();
    projectPortOffsetFromSshPort.mockImplementation((port?: number | null) => {
      if (!Number.isInteger(port)) return undefined;
      const offset = Number(port) - 30000;
      return offset >= 0 && offset < 15000 ? offset : undefined;
    });
    projectPortOffsetFromHttpPort.mockImplementation((port?: number | null) => {
      if (!Number.isInteger(port)) return undefined;
      const offset = Number(port) - 45000;
      return offset >= 0 && offset < 15000 ? offset : undefined;
    });
    acquireProjectPortLease
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      })
      .mockReturnValue({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      });
  });

  it("avoids project ports occupied by non-listening TCP sockets", async () => {
    const { parseOccupiedPortOffsetsFromProcNet } = await import("./projects");
    const procNet = [
      "  sl  local_address rem_address st",
      "   0: 0100007F:AFC9 0100007F:2382 01",
      "   1: 0100007F:7532 00000000:0000 0A",
      "   2: 0100007F:C350 00000000:0000 06",
    ].join("\n");

    expect([...parseOccupiedPortOffsetsFromProcNet(procNet)]).toEqual([
      1, 2, 5000,
    ]);
  });

  it("does not rehydrate ACP automations before runner start on start()", async () => {
    const order: string[] = [];
    const runnerApi = {
      start: jest.fn(async () => {
        order.push("runner:start");
        return { state: "running", http_port: 1234, ssh_port: 2222 };
      }),
      stop: jest.fn(),
    } as any;
    applyPendingCopies.mockImplementation(async () => {
      order.push("applyPendingCopies");
    });
    rehydrateAcpAutomationsForProject.mockImplementation(async () => {
      order.push("rehydrate");
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });
    await flushMicrotasks();

    expect(order).toEqual(["applyPendingCopies", "runner:start", "rehydrate"]);
    expect(rehydrateAcpAutomationsForProject).toHaveBeenCalledTimes(1);
    expect(upsertProjectStopState).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        last_started_ms: expect.any(Number),
      }),
    );
  });

  it("creates a missing home volume before starting a newly placed project", async () => {
    const volume = {
      path: `/mnt/cocalc/project-${project_id}`,
      quota: {
        get: jest.fn(async () => ({ used: 0, size: 0 })),
      },
    };
    getVolume.mockRejectedValueOnce(
      new Error(`project volume does not exist: ${volume.path}`),
    );
    ensureVolume.mockResolvedValueOnce(volume);
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(ensureVolume).toHaveBeenCalledWith(project_id, undefined, {
      reportProvisioned: false,
    });
    expect(volume.quota.get).toHaveBeenCalledTimes(1);
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
    expect(queueProjectProvisioned).toHaveBeenCalledWith(project_id, true);
  });

  it("prepares the fail-closed network policy before starting a free project", async () => {
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { network: false, disk_quota: 65_000 },
    });
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(
      assertManagedRawNetworkStartAllowedBestEffortMock,
    ).toHaveBeenCalledWith({
      project_id,
      managed_egress_override: undefined,
      raw_network_enabled: false,
    });
    expect(executeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "prepare-project-network-policy",
          project_id,
          "disabled",
        ],
      }),
    );
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when network containment cannot be prepared", async () => {
    executeCode.mockResolvedValueOnce({
      stdout: "",
      stderr: "nft unavailable",
      exit_code: 1,
    });
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
      "nft unavailable",
    );
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("does not replace an invalid project volume during start", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    try {
      getProject.mockReturnValue({
        image: DEFAULT_PROJECT_IMAGE,
        run_quota: { disk_quota: 65_000 },
      });
      getVolume.mockRejectedValueOnce(
        new Error(
          `project volume is not a btrfs subvolume: /mnt/cocalc/project-${project_id}`,
        ),
      );
      const runnerApi = {
        start: jest.fn(),
        stop: jest.fn(),
      } as any;

      const { wireProjectsApi } = await import("./projects");
      wireProjectsApi(runnerApi);

      await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
        "project volume is not a btrfs subvolume",
      );
      expect(ensureVolume).not.toHaveBeenCalled();
      expect(runnerApi.start).not.toHaveBeenCalled();
      expect(queueProjectProvisioned).not.toHaveBeenCalled();
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("does not report a project provisioned when runner start fails", async () => {
    const runnerApi = {
      start: jest.fn(async () => {
        throw new Error("restore failed");
      }),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
      "restore failed",
    );
    expect(queueProjectProvisioned).not.toHaveBeenCalled();
  });

  it("forces the provisioning report after automatic recovery", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id, restore: "recover" });

    expect(queueProjectProvisioned).toHaveBeenCalledWith(project_id, true, {
      forceReport: true,
    });
  });

  it("forces the provisioning report after an explicit restore", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      restore: "auto",
      restore_backup_id: "backup-1",
    });

    expect(queueProjectProvisioned).toHaveBeenCalledWith(project_id, true, {
      forceReport: true,
    });
  });

  it("materializes an unprovisioned project before reading its quota", async () => {
    const order: string[] = [];
    getRecordedProjectVolumeIdentity.mockReturnValue(undefined);
    ensureVolume.mockImplementationOnce(async () => {
      order.push("ensure-volume");
    });
    getVolume.mockImplementationOnce(async () => {
      order.push("read-quota");
      return {
        path: `/mnt/cocalc/project-${project_id}`,
        quota: { get: jest.fn(async () => ({ size: 0, used: 0 })) },
      };
    });
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      run_quota: { disk_quota: 10_000 },
    });

    expect(ensureVolume).toHaveBeenCalledWith(project_id, undefined, {
      reportProvisioned: false,
    });
    expect(order).toEqual(["ensure-volume", "read-quota"]);
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
    expect(queueProjectProvisioned).toHaveBeenCalledWith(project_id, true);
  });

  it("returns an existing runtime without restarting it for idempotent start", async () => {
    const runnerApi = {
      start: jest.fn(),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.start({ project_id, skip_if_running: true }),
    ).resolves.toMatchObject({
      state: "running",
      phase_timings_ms: {
        check_existing_runtime: expect.any(Number),
        total: expect.any(Number),
      },
    });
    expect(runnerApi.status).toHaveBeenCalledWith({ project_id });
    expect(runnerApi.start).not.toHaveBeenCalled();
    expect(applyPendingCopies).not.toHaveBeenCalled();
  });

  it("does not probe Podman twice when local state records a stopped runtime", async () => {
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: undefined,
      state: "opened",
    });
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      status: jest.fn(async () => ({ state: "opened" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id, skip_if_running: true });

    expect(runnerApi.status).not.toHaveBeenCalled();
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("skips the remote pending-copy claim after an authoritative empty check", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      apply_pending_copies: false,
    });

    expect(applyPendingCopies).not.toHaveBeenCalled();
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("does not skip an explicit restore when the runtime is active", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      restore_backup_id: "backup-1",
      skip_if_running: true,
    });

    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("overlaps a cold OCI estimate with start preparation", async () => {
    const estimate = {
      estimated_bytes: 4_000_000_000,
      compressed_bytes: 1_000_000_000,
      source: "skopeo" as const,
    };
    let resolveEstimate: ((value: typeof estimate) => void) | undefined;
    const estimatePromise = new Promise<typeof estimate>((resolve) => {
      resolveEstimate = resolve;
    });
    prepareOciPullReservationEstimate.mockReturnValueOnce(estimatePromise);
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const startPromise = hubApi.projects.start({ project_id });
    await flushMicrotasks();

    expect(prepareOciPullReservationEstimate).toHaveBeenCalledTimes(1);
    expect(applyPendingCopies).toHaveBeenCalledTimes(1);
    expect(runnerApi.start).not.toHaveBeenCalled();

    resolveEstimate?.(estimate);
    await startPromise;

    expect(withOciPullReservationIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ preparedEstimate: estimate }),
    );
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("verifies stop convergence before marking a project opened", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest
        .fn()
        .mockResolvedValueOnce({ state: "running" })
        .mockResolvedValueOnce({ state: "opened" }),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.stop({ project_id })).resolves.toBeUndefined();
    expect(runnerApi.status).toHaveBeenCalledTimes(2);
    expect(upsertProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id,
        state: "opened",
        http_port: null,
        ssh_port: null,
      }),
    );
  });

  it("prepares scratch after stop without blocking stop or repeating reset on restart", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    let resolveScratch:
      | ((value: {
          path: string;
          quota: {
            get: () => Promise<{ used: number; size: number }>;
            set: () => Promise<void>;
          };
        }) => void)
      | undefined;
    const scratchReset = new Promise<any>((resolve) => {
      resolveScratch = resolve;
    });
    let scratchPrepared = false;
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
      run_quota_revision: 9,
    });
    getVolume.mockResolvedValue({
      path: `/mnt/cocalc/project-${project_id}`,
      quota: {
        get: jest.fn(async () => ({
          used: 1_000,
          size: 65_000_000_000,
        })),
        set: jest.fn(async () => undefined),
      },
    });
    resetScratchVolume.mockImplementationOnce((_project_id, opts) => {
      opts?.onTiming?.("delete", 123);
      return scratchReset;
    });
    projectVolumeQuotaIsApplied.mockImplementation(
      (row) => row?.volume_kind === "home" || scratchPrepared,
    );
    reconcileManagedProjectVolumeQuota.mockImplementation(
      async ({ volume_kind }) => {
        if (volume_kind === "scratch") {
          scratchPrepared = true;
        }
        return 65_000_000_000;
      },
    );
    markProjectVolumeQuotaApplied.mockImplementation(({ volume_kind }) => {
      if (volume_kind === "scratch") {
        scratchPrepared = true;
      }
    });
    getProjectVolumeQuota.mockImplementation((_project_id, volume_kind) =>
      volume_kind === "scratch" ? { volume_kind } : undefined,
    );
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest.fn(async () => ({ state: "opened" })),
    } as any;

    try {
      const { wireProjectsApi } = await import("./projects");
      wireProjectsApi(runnerApi);

      const stopPromise = hubApi.projects.stop({ project_id });
      await flushMicrotasks();
      expect(resetScratchVolume).toHaveBeenCalledTimes(1);
      expect(resetScratchVolume).toHaveBeenCalledWith(
        project_id,
        expect.objectContaining({
          expected_lifecycle_generation: 0,
          onTiming: expect.any(Function),
        }),
      );
      await expect(stopPromise).resolves.toBeUndefined();

      const startPromise = hubApi.projects.start({ project_id });
      await flushMicrotasks();
      expect(runnerApi.start).not.toHaveBeenCalled();

      resolveScratch?.({
        path: `/mnt/cocalc/project-${project_id}-scratch`,
        quota: {
          get: jest.fn(async () => ({ used: 0, size: 65_000_000_000 })),
          set: jest.fn(async () => undefined),
        },
      });
      const startResult = await startPromise;

      expect(invalidateProjectVolumeQuota).toHaveBeenCalledWith({
        project_id,
        volume_kind: "scratch",
        reason: "project stopped; scratch reset pending",
        reset_required: true,
      });
      expect(resetScratchVolume).toHaveBeenCalledTimes(1);
      expect(startResult.phase_timings_ms).toEqual(
        expect.objectContaining({
          "check_quota.post_stop.scratch_reset.delete": 123,
        }),
      );
      expect(runnerApi.start).toHaveBeenCalledWith({
        project_id,
        config: expect.objectContaining({
          storage_quota_prepared: true,
          scratch_prepared: true,
        }),
      });
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("retries durable stopped scratch preparation after a process restart", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
      run_quota_revision: 9,
    });
    getProjectVolumeQuota.mockImplementation((_project_id, volume_kind) => ({
      project_id,
      volume_kind,
      desired_bytes: 65_000_000_000,
      desired_revision: 9,
      state: "applied",
    }));
    listStoppedScratchVolumePreparationBatch.mockReturnValue([
      {
        project_id,
        volume_kind: "scratch",
        reset_required: true,
      },
    ]);
    resetScratchVolume.mockResolvedValue({
      path: `/mnt/cocalc/project-${project_id}-scratch`,
      quota: {
        get: jest.fn(async () => ({ used: 0, size: 0 })),
        set: jest.fn(async () => undefined),
      },
    });
    getVolume.mockResolvedValue({
      path: `/mnt/cocalc/project-${project_id}`,
      quota: {
        get: jest.fn(async () => ({ used: 1_000, size: 65_000_000_000 })),
        set: jest.fn(async () => undefined),
      },
    });
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
      status: jest.fn(async () => ({ state: "opened" })),
    } as any;

    try {
      const { wireProjectsApi } = await import("./projects");
      const maintenance = wireProjectsApi(runnerApi);
      await expect(
        maintenance.runStoppedVolumePreparationSweep(),
      ).resolves.toBe(1);

      expect(resetScratchVolume).toHaveBeenCalledWith(
        project_id,
        expect.objectContaining({ expected_lifecycle_generation: 0 }),
      );
      expect(invalidateProjectVolumeQuota).not.toHaveBeenCalled();
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("falls back to synchronous scratch preparation after post-stop preparation fails", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    let scratchPrepared = false;
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
      run_quota_revision: 9,
    });
    resetScratchVolume
      .mockRejectedValueOnce(new Error("injected post-stop reset failure"))
      .mockResolvedValueOnce({
        path: `/mnt/cocalc/project-${project_id}-scratch`,
        quota: {
          get: jest.fn(async () => ({
            used: 0,
            size: 65_000_000_000,
          })),
          set: jest.fn(async () => undefined),
        },
      });
    projectVolumeQuotaIsApplied.mockImplementation(
      (row) => row?.volume_kind === "home" || scratchPrepared,
    );
    reconcileManagedProjectVolumeQuota.mockImplementation(
      async ({ volume_kind }) => {
        if (volume_kind === "scratch") {
          scratchPrepared = true;
        }
        return 65_000_000_000;
      },
    );
    markProjectVolumeQuotaApplied.mockImplementation(({ volume_kind }) => {
      if (volume_kind === "scratch") {
        scratchPrepared = true;
      }
    });
    getProjectVolumeQuota.mockImplementation((_project_id, volume_kind) =>
      volume_kind === "scratch" ? { volume_kind } : undefined,
    );
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest.fn(async () => ({ state: "opened" })),
    } as any;

    try {
      const { wireProjectsApi } = await import("./projects");
      wireProjectsApi(runnerApi);

      await hubApi.projects.stop({ project_id });
      await hubApi.projects.start({ project_id });

      expect(resetScratchVolume).toHaveBeenCalledTimes(2);
      expect(runnerApi.start).toHaveBeenCalledWith({
        project_id,
        config: expect.objectContaining({
          storage_quota_prepared: true,
          scratch_prepared: true,
        }),
      });
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("reports host-pressure stops with a durable runtime exit reason", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest.fn(async () => ({ state: "opened" })),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.stop({
        project_id,
        force: true,
        runtime_exit_reason: "host_pressure",
      }),
    ).resolves.toBeUndefined();
    expect(upsertProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id,
        state: "opened",
        runtime_exit_reason: "host_pressure",
      }),
    );
    expect(reportProjectStateToMaster).toHaveBeenLastCalledWith(
      project_id,
      expect.objectContaining({
        state: "opened",
        runtime_exit_reason: "host_pressure",
      }),
    );
  });

  it("fails stop when the runner still reports the project as active", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(async () => ({ state: "opened" })),
      status: jest.fn(async () => ({ state: "running" })),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.stop({ project_id })).rejects.toThrow(
      "project stop did not converge",
    );
    expect(runnerApi.status).toHaveBeenCalledTimes(5);
    expect(upsertProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        project_id,
        state: "running",
      }),
    );
  });

  it("forwards managed egress overrides to the raw-network start gate", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      managed_egress_override: "admin-host-drain",
    });

    expect(
      assertManagedRawNetworkStartAllowedBestEffortMock,
    ).toHaveBeenCalledWith({
      project_id,
      managed_egress_override: "admin-host-drain",
      raw_network_enabled: false,
    });
  });

  it("does not rehydrate ACP automations for createProject when start is false", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.createProject({ project_id, start: false });

    expect(rehydrateAcpAutomationsForProject).not.toHaveBeenCalled();
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("can register project metadata without materializing storage", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.createProject({
      project_id,
      start: false,
      ensure_volume: false,
    });

    expect(ensureVolume).not.toHaveBeenCalled();
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("checks Codex subscription usage through the hosted project app-server", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      tools_version: "tools-v1",
    });
    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexSubscriptionIdentity.mockResolvedValue("chatgpt-account-1");
    const liveStatus = {
      authentication: { status: "connected" },
      account: { account: { email: "user@example.com" } },
      rateLimits: { rateLimits: true },
      tokenUsage: { tokens: 7 },
      models: [
        {
          model: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          description: "Fast account model",
          reasoning: [],
          serviceTiers: [],
        },
      ],
      errors: {},
    };
    getCodexAppServerAccountStatus.mockResolvedValueOnce(liveStatus);

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const result = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      timeout: 60_000,
    });

    expect(resolveCodexAuthRuntime).toHaveBeenCalledWith({
      projectId: project_id,
      accountId: "acct-1",
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenCalledWith({
      projectId: project_id,
      accountId: "acct-1",
      isolatedCodexHome: true,
      includeModels: true,
      timeoutMs: 45_000,
    });
    expect(result).toMatchObject({
      available: true,
      project_id,
      paymentSource: {
        source: "subscription",
      },
      authentication: { status: "connected" },
      account: { account: { email: "user@example.com" } },
      models: [expect.objectContaining({ model: "gpt-5.6-luna" })],
      modelsCached: false,
    });

    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce({
      ...liveStatus,
      models: undefined,
    });
    const cached = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      timeout: 60_000,
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenLastCalledWith({
      projectId: project_id,
      accountId: "acct-1",
      isolatedCodexHome: true,
      includeModels: false,
      timeoutMs: 45_000,
    });
    expect(cached).toMatchObject({
      models: [expect.objectContaining({ model: "gpt-5.6-luna" })],
      modelsCached: true,
    });

    getCodexSubscriptionIdentity.mockResolvedValueOnce(
      "chatgpt-account-1:credential-v2",
    );
    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce({
      ...liveStatus,
      models: [
        {
          model: "gpt-6-astra",
          displayName: "GPT-6 Astra",
          description: "Newly available account model",
          reasoning: [],
          serviceTiers: [],
        },
      ],
    });
    const refreshedCredential = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeModels: true }),
    );
    expect(refreshedCredential).toMatchObject({
      models: [expect.objectContaining({ model: "gpt-6-astra" })],
      modelsCached: false,
    });

    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      tools_version: "tools-v2",
    });
    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce({
      ...liveStatus,
      models: [
        {
          model: "gpt-daybreak-blue-latest",
          displayName: "Daybreak Blue",
          description: "Defensive cybersecurity model",
          specialty: "cyber",
          reasoning: [],
          serviceTiers: [],
        },
      ],
    });
    const upgradedRuntime = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeModels: true }),
    );
    expect(upgradedRuntime).toMatchObject({
      models: [expect.objectContaining({ model: "gpt-daybreak-blue-latest" })],
      modelsCached: false,
    });

    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce(liveStatus);
    const refreshed = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      refresh_models: true,
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeModels: true }),
    );
    expect(refreshed).toMatchObject({
      models: [expect.objectContaining({ model: "gpt-5.6-luna" })],
      modelsCached: false,
    });

    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce({
      ...liveStatus,
      models: undefined,
    });
    const emptyRefresh = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      refresh_models: true,
    });
    expect(emptyRefresh.models).toBeUndefined();

    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockResolvedValueOnce(liveStatus);
    const afterEmptyRefresh = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
    });
    expect(getCodexAppServerAccountStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeModels: true }),
    );
    expect(afterEmptyRefresh).toMatchObject({
      models: [expect.objectContaining({ model: "gpt-5.6-luna" })],
      modelsCached: false,
    });

    let releaseConcurrentRefresh:
      | ((status: typeof liveStatus) => void)
      | undefined;
    resolveCodexAuthRuntime.mockResolvedValue({
      source: "subscription",
      contextId: "subscription-context",
      codexHome: "/tmp/codex-home",
      env: {},
    });
    getCodexAppServerAccountStatus.mockImplementationOnce(
      async () =>
        await new Promise<typeof liveStatus>((resolve) => {
          releaseConcurrentRefresh = resolve;
        }),
    );
    const callsBeforeConcurrentRefresh =
      getCodexAppServerAccountStatus.mock.calls.length;
    const refreshA = hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      refresh_models: true,
    });
    const refreshB = hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
      include_models: true,
      refresh_models: true,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(getCodexAppServerAccountStatus).toHaveBeenCalledTimes(
      callsBeforeConcurrentRefresh + 1,
    );
    releaseConcurrentRefresh?.(liveStatus);
    await expect(Promise.all([refreshA, refreshB])).resolves.toHaveLength(2);
  });

  it("does not start the Codex app-server for API-key usage sources", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    resolveCodexAuthRuntime.mockResolvedValueOnce({
      source: "project-api-key",
      contextId: "project-key-context",
      env: { OPENAI_API_KEY: "sk-test" },
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const result = await hubApi.projects.getCodexUsageStatus({
      account_id: "acct-1",
      project_id,
    });

    expect(getCodexAppServerAccountStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      available: false,
      project_id,
      paymentSource: {
        source: "project-api-key",
      },
      reason:
        "Live ChatGPT Codex usage is only available when Codex is using a ChatGPT Plan.",
    });
  });

  it("rehydrates ACP automations only after runner start on createProject when start is true", async () => {
    const order: string[] = [];
    const runnerApi = {
      start: jest.fn(async () => {
        order.push("runner:start");
        return { state: "running", http_port: 1234, ssh_port: 2222 };
      }),
      stop: jest.fn(),
    } as any;
    rehydrateAcpAutomationsForProject.mockImplementation(async () => {
      order.push("rehydrate");
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.createProject({ project_id, start: true });
    await flushMicrotasks();

    expect(order).toEqual(["runner:start", "rehydrate"]);
    expect(rehydrateAcpAutomationsForProject).toHaveBeenCalledTimes(1);
    expect(upsertProjectStopState).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        last_started_ms: expect.any(Number),
      }),
    );
  });

  it("keeps synthetic runtime probe storage and state host-local", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(async () => ({ state: "opened" })),
    } as any;
    sandboxExec.mockImplementation(async ({ script }: { script: string }) => {
      const marker = script.match(/printf '%s' '([^']+)'/)?.[1];
      return { stdout: marker ?? "", stderr: "", code: 0 };
    });
    deleteVolume.mockResolvedValue(undefined);

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      (hubApi.projects as any).runSyntheticRuntimeProbe(),
    ).resolves.toMatchObject({
      project_id: expect.any(String),
      duration_ms: expect.any(Number),
    });

    const syntheticProjectId = runnerApi.start.mock.calls[0][0].project_id;
    expect(ensureVolume).toHaveBeenCalledWith(syntheticProjectId, undefined, {
      reportProvisioned: false,
    });
    expect(markProjectStateReported).toHaveBeenCalled();
    expect(reportProjectStateToMaster).not.toHaveBeenCalled();
    expect(deleteVolume).toHaveBeenCalledWith(syntheticProjectId, {
      reportProvisioned: false,
    });
    expect(deleteProjectLocal).toHaveBeenCalledWith(syntheticProjectId);
  });

  it("does not overlap synthetic runtime probes after a caller times out", async () => {
    let resolveStart!: (value: { state: string }) => void;
    const startGate = new Promise<{ state: string }>((resolve) => {
      resolveStart = resolve;
    });
    const runnerApi = {
      start: jest.fn(async () => await startGate),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(async () => ({ state: "opened" })),
    } as any;
    sandboxExec.mockImplementation(async ({ script }: { script: string }) => {
      const marker = script.match(/printf '%s' '([^']+)'/)?.[1];
      return { stdout: marker ?? "", stderr: "", code: 0 };
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const first = (hubApi.projects as any).runSyntheticRuntimeProbe();
    await flushMicrotasks();
    await expect(
      (hubApi.projects as any).runSyntheticRuntimeProbe(),
    ).rejects.toThrow("synthetic runtime probe already in progress");

    resolveStart({ state: "running" });
    await expect(first).resolves.toMatchObject({
      project_id: expect.any(String),
    });
    expect(runnerApi.start).toHaveBeenCalledTimes(1);
  });

  it("does not wait for ACP rehydrate before returning from start()", async () => {
    let resolveRehydrate: (() => void) | undefined;
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    rehydrateAcpAutomationsForProject.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRehydrate = resolve;
        }),
    );

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const startPromise = hubApi.projects.start({ project_id });
    await expect(startPromise).resolves.toMatchObject({ scope_id: project_id });
    expect(rehydrateAcpAutomationsForProject).toHaveBeenCalledTimes(1);
    resolveRehydrate?.();
    await flushMicrotasks();
  });

  it("preserves explicit rootfs image names on createProject", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.createProject({
      project_id,
      image: customImage,
      start: true,
    });

    expect(upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({ project_id, image: customImage }),
    );
    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({ image: customImage }),
    });
  });

  it("rejects invalid explicit rootfs image names on createProject", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.createProject({
        project_id,
        image: "ubuntu26.04",
        start: true,
      }),
    ).rejects.toThrow(
      "invalid rootfs OCI image 'ubuntu26.04'; use a valid image reference such as 'buildpack-deps:26.04'",
    );

    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("preserves explicit rootfs image names on start()", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({ image: customImage, run_quota: undefined });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({
        image: customImage,
        ssh_port: 30123,
        http_port: 45123,
      }),
    });
  });

  it("raises an existing project volume quota before checking start admission", async () => {
    const quotaSet = jest.fn(async () => undefined);
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
    });
    getVolume.mockResolvedValueOnce({
      path: `/mnt/cocalc/project-${project_id}`,
      quota: {
        get: jest.fn(async () => ({
          used: 57_000_000_000,
          size: 50_000_000_000,
        })),
        set: quotaSet,
      },
    });
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(reconcileManagedProjectVolumeQuota).toHaveBeenCalledWith({
      operation_class: "project_volume_prepare",
      project_id,
      priority: "lifecycle",
      volume_kind: "home",
    });
    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({
        disk: 65_000_000_000,
      }),
    });
  });

  it("skips Btrfs quota work for an applied authoritative revision", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    projectVolumeQuotaIsApplied.mockReturnValue(true);
    getProjectVolumeQuota.mockImplementation((_project_id, volume_kind) => ({
      project_id,
      volume_kind,
    }));
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
      run_quota_revision: 9,
    });
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      status: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;

    try {
      const { wireProjectsApi } = await import("./projects");
      wireProjectsApi(runnerApi);

      await hubApi.projects.start({ project_id });

      expect(acceptProjectVolumeQuotaDesired).toHaveBeenCalledWith({
        project_id,
        volume_kind: "home",
        desired_bytes: 65_000_000_000,
        desired_revision: 9,
      });
      expect(getVolume).not.toHaveBeenCalled();
      expect(resetScratchVolume).not.toHaveBeenCalled();
      expect(runnerApi.status).not.toHaveBeenCalled();
      expect(runnerApi.start).toHaveBeenCalled();
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("resets and applies scratch before attesting a cold start", async () => {
    const previousMode = process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
    process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = "enforce";
    getProject.mockReturnValue({
      image: DEFAULT_PROJECT_IMAGE,
      run_quota: { disk_quota: 65_000 },
      run_quota_revision: 9,
    });
    getProjectVolumeQuota.mockImplementation((_project_id, volume_kind) => ({
      project_id,
      volume_kind,
      desired_bytes: 65_000_000_000,
      desired_revision: 9,
      state: "applied",
    }));
    getVolume.mockResolvedValueOnce({
      path: `/mnt/cocalc/project-${project_id}`,
      quota: {
        get: jest.fn(async () => ({
          used: 1_000,
          size: 65_000_000_000,
        })),
        set: jest.fn(async () => undefined),
      },
    });
    const scratchQuotaGet = jest.fn(async () => ({ used: 0, size: 0 }));
    const scratchQuotaSet = jest.fn(async () => undefined);
    resetScratchVolume.mockResolvedValueOnce({
      path: `/mnt/cocalc/project-${project_id}-scratch`,
      quota: {
        get: scratchQuotaGet,
        set: scratchQuotaSet,
      },
    });
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      status: jest.fn(async () => ({ state: "opened" })),
      stop: jest.fn(),
    } as any;

    try {
      const { wireProjectsApi } = await import("./projects");
      wireProjectsApi(runnerApi);

      await hubApi.projects.start({ project_id });

      expect(resetScratchVolume).toHaveBeenCalledWith(
        project_id,
        expect.objectContaining({ onTiming: expect.any(Function) }),
      );
      expect(reconcileManagedProjectVolumeQuota).toHaveBeenCalledWith({
        project_id,
        volume_kind: "scratch",
        operation_class: "project_volume_prepare",
        priority: "lifecycle",
        force_write: true,
      });
      expect(scratchQuotaGet).not.toHaveBeenCalled();
      expect(runnerApi.start).toHaveBeenCalledWith({
        project_id,
        config: expect.objectContaining({
          storage_quota_prepared: true,
          scratch_prepared: true,
        }),
      });
    } finally {
      if (previousMode == null) {
        delete process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE;
      } else {
        process.env.COCALC_PROJECT_QUOTA_LEDGER_MODE = previousMode;
      }
    }
  });

  it("rejects invalid persisted rootfs image names on start()", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({ image: "ubuntu26.04", run_quota: undefined });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
      "invalid rootfs OCI image 'ubuntu26.04'; use a valid image reference such as 'buildpack-deps:26.04'",
    );

    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("retries start with rotated ports when pasta reports a bind collision", async () => {
    const runnerApi = {
      start: jest
        .fn()
        .mockRejectedValueOnce({
          error: {
            message:
              "pasta failed with exit code 1: Failed to bind port 30123 (Address already in use)",
          },
        })
        .mockResolvedValueOnce({
          state: "running",
          http_port: 45124,
          ssh_port: 30124,
        }),
      stop: jest.fn(),
    } as any;
    acquireProjectPortLease.mockReset();
    acquireProjectPortLease
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      })
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30124,
        http_port: 45124,
      });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(1, project_id, {
      avoidOffsets: new Set(),
      rotate: undefined,
    });
    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(2, project_id, {
      avoidOffsets: new Set([123]),
      rotate: true,
    });
    expect(runnerApi.start).toHaveBeenNthCalledWith(1, {
      project_id,
      config: expect.objectContaining({
        ssh_port: 30123,
        http_port: 45123,
      }),
    });
    expect(runnerApi.start).toHaveBeenNthCalledWith(2, {
      project_id,
      config: expect.objectContaining({
        ssh_port: 30124,
        http_port: 45124,
      }),
    });
  });

  it("retries start when the bind error is nested inside an Error object", async () => {
    const runnerApi = {
      start: jest
        .fn()
        .mockRejectedValueOnce({
          error: new Error(
            "pasta failed with exit code 1: Failed to bind port 30123 (Address already in use)",
          ),
        })
        .mockResolvedValueOnce({
          state: "running",
          http_port: 45124,
          ssh_port: 30124,
        }),
      stop: jest.fn(),
    } as any;
    acquireProjectPortLease.mockReset();
    acquireProjectPortLease
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      })
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30124,
        http_port: 45124,
      });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(1, project_id, {
      avoidOffsets: new Set(),
      rotate: undefined,
    });
    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(2, project_id, {
      avoidOffsets: new Set([123]),
      rotate: true,
    });
    expect(runnerApi.start).toHaveBeenCalledTimes(2);
  });

  it("retries start when the bind error is only present in a non-enumerable Error cause", async () => {
    const nested = new Error(
      "pasta failed with exit code 1: Failed to bind port 30123 (Address already in use)",
    );
    const wrapped = new Error("calling remote function 'startProject' failed", {
      cause: nested,
    });
    const runnerApi = {
      start: jest.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce({
        state: "running",
        http_port: 45124,
        ssh_port: 30124,
      }),
      stop: jest.fn(),
    } as any;
    acquireProjectPortLease.mockReset();
    acquireProjectPortLease
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      })
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30124,
        http_port: 45124,
      });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(1, project_id, {
      avoidOffsets: new Set(),
      rotate: undefined,
    });
    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(2, project_id, {
      avoidOffsets: new Set([123]),
      rotate: true,
    });
    expect(runnerApi.start).toHaveBeenCalledTimes(2);
  });

  it("does not recycle an earlier failed port pair within the same retry loop", async () => {
    const runnerApi = {
      start: jest
        .fn()
        .mockRejectedValueOnce({
          error: {
            message:
              "pasta failed with exit code 1: Failed to bind port 30123 (Address already in use)",
          },
        })
        .mockRejectedValueOnce({
          error: {
            message:
              "pasta failed with exit code 1: Failed to bind port 30124 (Address already in use)",
          },
        })
        .mockResolvedValueOnce({
          state: "running",
          http_port: 45125,
          ssh_port: 30125,
        }),
      stop: jest.fn(),
    } as any;
    acquireProjectPortLease.mockReset();
    acquireProjectPortLease
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30123,
        http_port: 45123,
      })
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30124,
        http_port: 45124,
      })
      .mockReturnValueOnce({
        project_id,
        ssh_port: 30125,
        http_port: 45125,
      });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(1, project_id, {
      avoidOffsets: new Set(),
      rotate: undefined,
    });
    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(2, project_id, {
      avoidOffsets: new Set([123]),
      rotate: true,
    });
    expect(acquireProjectPortLease).toHaveBeenNthCalledWith(3, project_id, {
      avoidOffsets: new Set([123, 124]),
      rotate: true,
    });
    expect(runnerApi.start).toHaveBeenNthCalledWith(3, {
      project_id,
      config: expect.objectContaining({
        ssh_port: 30125,
        http_port: 45125,
      }),
    });
  });

  it("hydrates missing image from master metadata on local start()", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: undefined,
      title: undefined,
      authorized_keys: undefined,
      run_quota: undefined,
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      title: "dev",
      users: { "test-account-id": { group: "owner" } },
      image: customImage,
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: { memory_limit: 1234 },
      env: { FOO: "bar" },
      secrets: { API_KEY: "secret" },
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(callHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        name: "hosts.getProjectStartMetadata",
        args: [{ project_id }],
      }),
    );
    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({
        image: customImage,
        authorized_keys: "ssh-ed25519 AAAATEST user@test",
        env: { FOO: "bar" },
        secrets: { API_KEY: "secret" },
      }),
    });
    expect(upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        title: "dev",
        image: customImage,
        secret_names: ["API_KEY"],
      }),
    );
  });

  it("uses metadata carried by the start RPC without calling the master", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: undefined,
      title: undefined,
      authorized_keys: undefined,
      run_quota: undefined,
    });
    getMasterConatClient.mockReturnValue({ nats: true });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({
      project_id,
      start_metadata: {
        title: "dev",
        users: { "test-account-id": { group: "owner" } },
        image: customImage,
        authorized_keys: "ssh-ed25519 AAAATEST user@test",
        run_quota: { memory_limit: 1234 },
        env: { FOO: "bar" },
      },
    });

    expect(callHub).not.toHaveBeenCalled();
    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({
        image: customImage,
        authorized_keys: "ssh-ed25519 AAAATEST user@test",
        env: { FOO: "bar" },
      }),
    });
    expect(upsertProject).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        title: "dev",
        image: customImage,
      }),
    );
  });

  it("rejects local autostarts when master metadata disables automatic starts", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: customImage,
      title: "dev",
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: { memory_limit: 1234 },
      env: { FOO: "bar" },
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      title: "dev",
      users: { "test-account-id": { group: "owner" } },
      image: customImage,
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: { memory_limit: 1234 },
      env: { FOO: "bar" },
      autostart_enabled: false,
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.start({ project_id, autostart: true }),
    ).rejects.toThrow("Automatic starts are disabled");

    expect(callHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        name: "hosts.getProjectStartMetadata",
        args: [{ project_id }],
      }),
    );
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("requires fresh browser presence after a browser-idle stop", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({ state: "running" })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      state: "opened",
      runtime_exit_reason: "browser_idle_timeout",
      image: customImage,
      run_quota: { browser_idle_timeout: 1800 },
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      title: "free project",
      users: { "test-account-id": { group: "owner" } },
      image: customImage,
      run_quota: { browser_idle_timeout: 1800 },
      autostart_enabled: true,
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.start({ project_id, autostart: true }),
    ).rejects.toThrow("CoCalc browser tabs closed");
    expect(hasRecentProjectBrowserActivity).toHaveBeenCalledWith({
      project_id,
      max_age_ms: 120_000,
    });
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("fails closed when cached secret names exist but master metadata is unavailable", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: customImage,
      title: "dev",
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: undefined,
      secret_names: ["API_KEY"],
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockRejectedValue(new Error("master unavailable"));

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
      "refusing to start without configured secrets",
    );
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("falls back to persisted current-image.txt when master metadata is unavailable", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    const managedImage =
      "cocalc.local/rootfs/f3426fdb7f1395f052b65ba218ce8c315045fba3817ab8deec6fd163d24b5997";
    getProject.mockReturnValue({
      image: undefined,
      title: undefined,
      authorized_keys: undefined,
      run_quota: undefined,
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockRejectedValue(new Error("master unavailable"));
    readFile.mockImplementation(async (path: string) =>
      `${path}`.endsWith("current-image.txt") ? managedImage : "",
    );

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({ image: managedImage }),
    });
  });

  it("fails start when no image metadata is available", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: undefined,
      title: undefined,
      authorized_keys: undefined,
      run_quota: undefined,
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockRejectedValue(new Error("master unavailable"));
    readFile.mockResolvedValue("");

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(hubApi.projects.start({ project_id })).rejects.toThrow(
      `unable to determine project image for ${project_id}; refusing to fall back to the default image`,
    );
    expect(runnerApi.start).not.toHaveBeenCalled();
  });

  it("accepts the default image when it comes from authoritative metadata", async () => {
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({
      image: undefined,
      title: undefined,
      authorized_keys: undefined,
      run_quota: undefined,
    });
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      title: "dev",
      users: { "test-account-id": { group: "owner" } },
      image: DEFAULT_PROJECT_IMAGE,
      authorized_keys: "ssh-ed25519 AAAATEST user@test",
      run_quota: { memory_limit: 1234 },
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({ image: DEFAULT_PROJECT_IMAGE }),
    });
  });

  it("does not block project start on regional RootFS replication", async () => {
    const managedImage =
      "cocalc.local/rootfs/f3426fdb7f1395f052b65ba218ce8c315045fba3817ab8deec6fd163d24b5997";
    const runnerApi = {
      start: jest.fn(async () => ({
        state: "running",
        http_port: 1234,
        ssh_port: 2222,
      })),
      stop: jest.fn(),
    } as any;
    getProject.mockReturnValue({ image: managedImage, run_quota: undefined });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.start({ project_id });

    expect(pullRootfsCacheEntry).toHaveBeenCalledWith(managedImage, {
      onProgress: expect.any(Function),
      awaitRegionalReplication: false,
    });
    expect(runnerApi.start).toHaveBeenCalledWith({
      project_id,
      config: expect.objectContaining({ image: managedImage }),
    });
  });

  it("translates chat store paths on project-host before rotating", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    rotateChatStore.mockResolvedValue({
      rotated: true,
      chat_id: "chat-1",
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.chatStoreRotate({
      account_id: "acct-1",
      project_id,
      chat_path: "/home/user/cocalc-ai/lite4.chat",
      db_path: "/home/user/.local/share/cocalc/chat.sqlite",
      keep_recent_messages: 200,
    });

    expect(resolveProjectContainerPath).toHaveBeenNthCalledWith(
      1,
      project_id,
      "/home/user/cocalc-ai/lite4.chat",
    );
    expect(resolveProjectContainerPath).toHaveBeenNthCalledWith(
      2,
      project_id,
      "/home/user/.local/share/cocalc/chat.sqlite",
    );
    expect(rotateChatStore).toHaveBeenCalledWith({
      chat_path: "/projects/host/home/user/cocalc-ai/lite4.chat",
      db_path: "/projects/host/home/user/.local/share/cocalc/chat.sqlite",
      keep_recent_messages: 200,
      max_head_bytes: undefined,
      max_head_messages: undefined,
      require_idle: undefined,
      force: undefined,
      dry_run: undefined,
    });
  });

  it("translates chat store paths on project-host before reading archived rows", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    readChatStoreArchived.mockResolvedValue({
      chat_id: "chat-1",
      rows: [{ row_id: 1, segment_id: "seg-1", row: {} }],
      offset: 0,
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    const result = await hubApi.projects.chatStoreReadArchived({
      account_id: "acct-1",
      project_id,
      chat_path: "/home/user/cocalc-ai/lite4.chat",
      thread_id: "rocket-raccoon",
      limit: 100,
      offset: 20,
    });

    expect(readChatStoreArchived).toHaveBeenCalledWith({
      chat_path: "/projects/host/home/user/cocalc-ai/lite4.chat",
      before_date_ms: undefined,
      db_path: undefined,
      thread_id: "rocket-raccoon",
      limit: 100,
      offset: 20,
    });
    expect(result).toEqual({
      chat_id: "chat-1",
      rows: [{ row_id: 1, segment_id: "seg-1", row: {} }],
      offset: 0,
    });
  });

  it("looks up project owner effective limits over the host hub bridge for backup quota", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      max_backups_per_project: 5,
      max_snapshots_per_project: 8,
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await expect(
      hubApi.projects.getBackupQuota({ project_id }),
    ).resolves.toEqual({ limit: 5 });
    expect(callHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        name: "hosts.getProjectOwnerEffectiveLimits",
        args: [{ project_id }],
      }),
    );
  });

  it("looks up account effective limits over the host hub bridge", async () => {
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      acp_max_queued_per_account: 4,
      acp_max_running_per_account: 2,
    });

    const { getAccountEffectiveLimits } = await import("./projects");

    await expect(getAccountEffectiveLimits("actor-1")).resolves.toEqual({
      acp_max_queued_per_account: 4,
      acp_max_running_per_account: 2,
    });
    expect(callHub).toHaveBeenCalledWith(
      expect.objectContaining({
        host_id: "host-1",
        name: "hosts.getAccountEffectiveLimits",
        args: [{ account_id: "actor-1" }],
      }),
    );
  });

  it("passes the owner backup limit from the hub bridge into host-local backup creation", async () => {
    const runnerApi = {
      start: jest.fn(),
      stop: jest.fn(),
    } as any;
    getMasterConatClient.mockReturnValue({ nats: true });
    callHub.mockResolvedValue({
      max_backups_per_project: 5,
      max_snapshots_per_project: 8,
    });
    fileServerCreateBackup.mockResolvedValue({
      id: "backup-1",
      time: new Date("2026-04-28T20:00:00Z"),
      size: 1,
    });

    const { wireProjectsApi } = await import("./projects");
    wireProjectsApi(runnerApi);

    await hubApi.projects.createBackup({ project_id });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(fileServerCreateBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id,
        limit: 5,
      }),
    );
  });
});
