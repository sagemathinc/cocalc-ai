const createFileClient = jest.fn();
const filesystem = jest.fn();

jest.mock("@cocalc/conat/files/file-server", () => ({
  client: (...args: any[]) => createFileClient(...args),
}));

jest.mock("@cocalc/file-server/btrfs", () => ({
  filesystem: (...args: any[]) => filesystem(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  sshServer: { host: "localhost", port: 2222 },
  projectRunnerMountpoint: "",
  rusticRepo: "/tmp/rustic",
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
    delete process.env.COCALC_PROJECT_PATH;
  });

  it("does not propagate a zero home quota into scratch", async () => {
    const ensureVolume = jest.fn(async () => undefined);
    const setQuota = jest.fn(async () => undefined);
    const getQuota = jest.fn(async () => ({ size: 0 }));
    const mount = jest.fn(async ({ scratch }: { scratch?: boolean }) => ({
      path: scratch ? "/mnt/project-scratch" : "/mnt/project-home",
    }));
    createFileClient.mockReturnValue({
      ensureVolume,
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
      scratch: "/mnt/project-scratch",
    });

    expect(ensureVolume).toHaveBeenCalledTimes(2);
    expect(getQuota).toHaveBeenCalledWith({
      project_id: "00000000-1000-4000-8000-000000000000",
    });
    expect(setQuota).not.toHaveBeenCalled();
  });
});
