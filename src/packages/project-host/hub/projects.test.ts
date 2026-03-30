import { hubApi } from "@cocalc/lite/hub/api";

const rehydrateAcpAutomationsForProject = jest.fn();
const applyPendingCopies = jest.fn();
const upsertProject = jest.fn();
const getProject = jest.fn();
const getOrCreateProjectLocalSecretToken = jest.fn();
const reportProjectStateToMaster = jest.fn();
const writeManagedAuthorizedKeys = jest.fn();
const withOciPullReservationIfNeeded = jest.fn(
  async ({ fn }: { fn: () => Promise<any> }) => await fn(),
);

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
  readFile: jest.fn(async () => ""),
}));
jest.mock("../sqlite/projects", () => ({
  getProject: (...args: any[]) => getProject(...args),
  getOrCreateProjectLocalSecretToken: (...args: any[]) =>
    getOrCreateProjectLocalSecretToken(...args),
  upsertProject: (...args: any[]) => upsertProject(...args),
}));
jest.mock("../master-status", () => ({
  reportProjectStateToMaster: (...args: any[]) =>
    reportProjectStateToMaster(...args),
}));
jest.mock("../file-server", () => ({
  writeManagedAuthorizedKeys: (...args: any[]) =>
    writeManagedAuthorizedKeys(...args),
  getVolume: jest.fn(),
  ensureVolume: jest.fn(),
  getMountPoint: jest.fn(() => "/mnt/cocalc"),
}));
jest.mock("../pending-copies", () => ({
  applyPendingCopies: (...args: any[]) => applyPendingCopies(...args),
}));
jest.mock("@cocalc/lite/hub/acp", () => ({
  rehydrateAcpAutomationsForProject: (...args: any[]) =>
    rehydrateAcpAutomationsForProject(...args),
}));
jest.mock("../storage-reservations", () => ({
  withOciPullReservationIfNeeded: (...args: any[]) =>
    withOciPullReservationIfNeeded(...args),
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
});
