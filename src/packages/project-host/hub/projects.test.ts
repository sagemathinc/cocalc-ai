import { hubApi } from "@cocalc/lite/hub/api";

const rehydrateAcpAutomationsForProject = jest.fn();
const applyPendingCopies = jest.fn();
const upsertProject = jest.fn();
const getProject = jest.fn();
const getOrCreateProjectLocalSecretToken = jest.fn();
const reportProjectStateToMaster = jest.fn();
const writeManagedAuthorizedKeys = jest.fn();
const pullRootfsCacheEntry = jest.fn(async () => undefined);
const withOciPullReservationIfNeeded = jest.fn(
  async ({ fn }: { fn: () => Promise<any> }) => await fn(),
);
const readFile = jest.fn(async () => "");
const callHub = jest.fn();
const getLocalHostId = jest.fn(() => "host-1");
const getMasterConatClient = jest.fn();
const getVolume = jest.fn(async () => ({ path: "/mnt/cocalc/project-test" }));

jest.mock("@cocalc/lite/hub/api", () => ({ hubApi: { projects: {} as any } }));
jest.mock("@cocalc/backend/data", () => ({
  account_id: "test-account-id",
  data: "/tmp",
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
  getProject: (...args: any[]) => getProject(...args),
  getOrCreateProjectLocalSecretToken: (...args: any[]) =>
    getOrCreateProjectLocalSecretToken(...args),
  upsertProject: (...args: any[]) => upsertProject(...args),
}));
jest.mock("../master-status", () => ({
  getMasterConatClient: (...args: any[]) => getMasterConatClient(...args),
  reportProjectStateToMaster: (...args: any[]) =>
    reportProjectStateToMaster(...args),
}));
jest.mock("../file-server", () => ({
  writeManagedAuthorizedKeys: (...args: any[]) =>
    writeManagedAuthorizedKeys(...args),
  getVolume: (...args: any[]) => getVolume(...args),
  ensureVolume: jest.fn(),
  getMountPoint: jest.fn(() => "/mnt/cocalc"),
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

describe("project host start ACP rehydrate ordering", () => {
  const project_id = "3f5d0b28-cf69-4c78-9b0a-ea747bc7acb3";
  const customImage = "ghcr.io/example/custom-rootfs:2026-03-21";
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (hubApi.projects as any) = {};
    getProject.mockReturnValue({ image: "ubuntu2404", run_quota: undefined });
    getOrCreateProjectLocalSecretToken.mockReturnValue("secret");
    applyPendingCopies.mockResolvedValue(undefined);
    writeManagedAuthorizedKeys.mockResolvedValue(undefined);
    pullRootfsCacheEntry.mockResolvedValue(undefined);
    readFile.mockResolvedValue("");
    callHub.mockReset();
    getMasterConatClient.mockReturnValue(undefined);
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
      config: expect.objectContaining({ image: customImage }),
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
});
