const createFileClient = jest.fn();
const filesystem = jest.fn();
const mockExists = jest.fn();
let mockProjectRunnerMountpoint = "";

jest.mock("@cocalc/conat/files/file-server", () => ({
  client: (...args: any[]) => createFileClient(...args),
}));

jest.mock("@cocalc/file-server/btrfs", () => ({
  filesystem: (...args: any[]) => filesystem(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  sshServer: { host: "localhost", port: 2222 },
  get projectRunnerMountpoint() {
    return mockProjectRunnerMountpoint;
  },
  rusticRepo: "/tmp/rustic",
}));

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: (...args: any[]) => mockExists(...args),
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
  };
});

describe("localPath remote quota fallback", () => {
  beforeEach(() => {
    jest.resetModules();
    createFileClient.mockReset();
    filesystem.mockReset();
    mockExists.mockReset();
    mockProjectRunnerMountpoint = "";
    delete process.env.COCALC_PROJECT_PATH;
  });

  it("does not propagate a zero home quota into scratch", async () => {
    const ensureVolume = jest.fn(async () => undefined);
    const resetScratchVolume = jest.fn(async () => undefined);
    const setQuota = jest.fn(async () => undefined);
    const getQuota = jest.fn(async () => ({ size: 0 }));
    const mount = jest.fn(async ({ scratch }: { scratch?: boolean }) => ({
      path: scratch ? "/mnt/project-scratch" : "/mnt/project-home",
    }));
    createFileClient.mockReturnValue({
      ensureVolume,
      resetScratchVolume,
      setQuota,
      getQuota,
      mount,
    });

    const mod = await import("./run/filesystem");
    mod.init({ client: {} as any });

    await expect(
      mod.localPath({
        project_id: "00000000-1000-4000-8000-000000000000",
      }),
    ).resolves.toEqual({
      home: "/mnt/project-home",
      quota_applied: false,
      scratch: "/mnt/project-scratch",
    });

    expect(ensureVolume).toHaveBeenCalledTimes(2);
    expect(resetScratchVolume).not.toHaveBeenCalled();
    expect(getQuota).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(setQuota).not.toHaveBeenCalled();
  });

  it("resets remote scratch when requested", async () => {
    const ensureVolume = jest.fn(async () => undefined);
    const resetScratchVolume = jest.fn(async () => undefined);
    const setQuota = jest.fn(async () => undefined);
    const getQuota = jest.fn(async () => ({ size: 1024 }));
    const mount = jest.fn(async ({ scratch }: { scratch?: boolean }) => ({
      path: scratch ? "/mnt/project-scratch" : "/mnt/project-home",
    }));
    createFileClient.mockReturnValue({
      ensureVolume,
      resetScratchVolume,
      setQuota,
      getQuota,
      mount,
    });

    const mod = await import("./run/filesystem");
    mod.init({ client: {} as any });

    await expect(
      mod.localPath({
        project_id: "00000000-1000-4000-8000-000000000000",
        resetScratch: true,
      }),
    ).resolves.toEqual({
      home: "/mnt/project-home",
      quota_applied: false,
      scratch: "/mnt/project-scratch",
    });

    expect(ensureVolume).toHaveBeenCalledTimes(1);
    expect(ensureVolume).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(resetScratchVolume).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(setQuota).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
      size: 1024,
      scratch: true,
    });
  });

  it("resets local btrfs scratch before ensuring it", async () => {
    mockProjectRunnerMountpoint = "/mnt/cocalc";
    mockExists.mockResolvedValue(true);
    const ensure = jest.fn(async (name: string) => ({
      path: `/mnt/cocalc/${name}`,
      quota: {
        get: jest.fn(async () => ({ size: 2048 })),
        set: jest.fn(async () => undefined),
      },
    }));
    const get = jest.fn(async (name: string) => ({
      path: `/mnt/cocalc/${name}`,
    }));
    const deleteSubvolume = jest.fn(async () => undefined);
    filesystem.mockResolvedValue({
      subvolumes: {
        ensure,
        get,
        delete: deleteSubvolume,
      },
    });

    const mod = await import("./run/filesystem");
    mod.init({ client: {} as any });

    await expect(
      mod.localPath({
        project_id: "00000000-1000-4000-8000-000000000000",
        disk: 4096,
        resetScratch: true,
      }),
    ).resolves.toEqual({
      home: "/mnt/cocalc/project-00000000-1000-4000-8000-000000000000",
      quota_applied: true,
      scratch:
        "/mnt/cocalc/project-00000000-1000-4000-8000-000000000000-scratch",
    });

    expect(get).toHaveBeenCalledWith(
      "project-00000000-1000-4000-8000-000000000000-scratch",
    );
    expect(deleteSubvolume).toHaveBeenCalledWith(
      "project-00000000-1000-4000-8000-000000000000-scratch",
    );
    expect(ensure).toHaveBeenCalledWith(
      "project-00000000-1000-4000-8000-000000000000",
    );
    expect(ensure).toHaveBeenCalledWith(
      "project-00000000-1000-4000-8000-000000000000-scratch",
    );
  });
});
