import { mkdir, readFile, rm, writeFile } from "fs/promises";

const executeCode = jest.fn();
const extractBaseImage = jest.fn();
const registerProgress = jest.fn();
const lroProgress = jest.fn();

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCode(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  data: "/mnt/cocalc/data",
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

jest.mock("@cocalc/conat/lro/progress", () => ({
  lroProgress: (...args: any[]) => lroProgress(...args),
}));

jest.mock("./run/conat-client", () => ({
  getConatClient: jest.fn(() => ({})),
}));

jest.mock("fs/promises", () => ({
  mkdir: jest.fn(),
  readFile: jest.fn(),
  rm: jest.fn(),
  writeFile: jest.fn(),
}));

jest.mock("./run/rootfs-base", () => ({
  extractBaseImage: (...args: any[]) => extractBaseImage(...args),
  imageCachePath: (image: string) => `/cache/${encodeURIComponent(image)}`,
  imagePathComponent: (image: string) => encodeURIComponent(image),
  registerProgress: (...args: any[]) => registerProgress(...args),
}));

jest.mock("./run/podman", () => ({
  getImage: (config: { image?: string }) => config.image,
}));

const mockedMkdir = jest.mocked(mkdir);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const mockedWriteFile = jest.mocked(writeFile);

describe("rootfs overlay mount recovery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadFile.mockResolvedValue("" as any);
    mockedMkdir.mockResolvedValue(undefined);
    mockedRm.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
    extractBaseImage.mockResolvedValue(
      "/cache/docker.io%2Fbuildpack-deps%3Anoble-scm",
    );
    executeCode.mockResolvedValue({ stdout: "" });
  });

  it("fails with explicit cleanup instructions on stale upperdir origin errors", async () => {
    executeCode.mockRejectedValueOnce(
      new Error(
        "mount failed: Stale file handle; overlayfs: failed to verify upper root origin",
      ),
    );

    const mod = await import("./run/rootfs");

    await expect(
      mod.mount({
        project_id: "proj-recover",
        home: "/mnt/cocalc/project-proj-recover",
        config: { image: "docker.io/buildpack-deps:noble-scm" } as any,
      }),
    ).rejects.toThrow(
      /project RootFS overlay is incompatible with the current cached base image/,
    );

    const upperdir =
      "/mnt/cocalc/project-proj-recover/.local/share/cocalc/rootfs/docker.io%2Fbuildpack-deps%3Anoble-scm/upperdir";

    expect(executeCode).toHaveBeenCalledTimes(1);
    expect(mockedRm).not.toHaveBeenCalledWith(upperdir, {
      recursive: true,
      force: true,
    });
  });

  it("does not reset the overlay for unrelated mount failures", async () => {
    executeCode.mockRejectedValueOnce(new Error("permission denied"));

    const mod = await import("./run/rootfs");

    await expect(
      mod.mount({
        project_id: "proj-fail",
        home: "/mnt/cocalc/project-proj-fail",
        config: { image: "docker.io/buildpack-deps:noble-scm" } as any,
      }),
    ).rejects.toThrow(/permission denied/);

    const upperdir =
      "/mnt/cocalc/project-proj-fail/.local/share/cocalc/rootfs/docker.io%2Fbuildpack-deps%3Anoble-scm/upperdir";

    expect(mockedRm).not.toHaveBeenCalledWith(upperdir, expect.anything());
    expect(executeCode).toHaveBeenCalledTimes(1);
  });
});
