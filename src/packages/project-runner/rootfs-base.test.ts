const exists = jest.fn();
const executeCode = jest.fn();
const pullImage = jest.fn();
const preflightPulledOciImage = jest.fn();
const preflightRootfsInPlace = jest.fn();
const loadRootfsPreflightMetadata = jest.fn();
const requireCurrentRootfsPreflightMetadata = jest.fn();
const writeRootfsPreflightMetadata = jest.fn();

jest.mock("@cocalc/backend/data", () => ({
  data: "/mnt/cocalc/data",
}));

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: (...args: any[]) => exists(...args),
}));

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCode(...args),
}));

jest.mock("@cocalc/util/reuse-in-flight", () => ({
  reuseInFlight: (fn: any) => fn,
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

jest.mock("./run/pull-image", () => ({
  __esModule: true,
  default: (...args: any[]) => pullImage(...args),
}));

jest.mock("./run/rootfs-normalize", () => ({
  loadRootfsPreflightMetadata: (...args: any[]) =>
    loadRootfsPreflightMetadata(...args),
  preflightPulledOciImage: (...args: any[]) => preflightPulledOciImage(...args),
  preflightRootfsInPlace: (...args: any[]) => preflightRootfsInPlace(...args),
  requireCurrentRootfsPreflightMetadata: (...args: any[]) =>
    requireCurrentRootfsPreflightMetadata(...args),
  writeRootfsPreflightMetadata: (...args: any[]) =>
    writeRootfsPreflightMetadata(...args),
}));

describe("extractBaseImage OCI preflight", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    exists.mockResolvedValue(false);
    pullImage.mockResolvedValue(undefined);
    preflightPulledOciImage.mockRejectedValue(
      new Error(
        "failed OCI image preflight for 'docker.io/library/alpine:latest': OCI image preflight failed: glibc is required",
      ),
    );
    executeCode.mockResolvedValue({ stdout: "", stderr: "", exit_code: 0 });
  });

  it("removes the pulled image when mounted-image preflight rejects it", async () => {
    const mod = await import("./run/rootfs-base");

    await expect(
      mod.extractBaseImage("docker.io/library/alpine:latest"),
    ).rejects.toThrow(/glibc is required/);

    expect(pullImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "docker.io/library/alpine:latest",
      }),
    );
    expect(preflightPulledOciImage).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "docker.io/library/alpine:latest",
      }),
    );
    expect(preflightRootfsInPlace).not.toHaveBeenCalled();
    expect(executeCode).toHaveBeenCalledWith({
      command: "podman",
      args: ["image", "rm", "docker.io/library/alpine:latest"],
    });
  });
});
