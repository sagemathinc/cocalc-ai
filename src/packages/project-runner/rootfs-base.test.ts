const exists = jest.fn();
const executeCode = jest.fn();
const pullImage = jest.fn();
const preflightPulledOciImage = jest.fn();
const preflightRootfsInPlace = jest.fn();
const loadRootfsPreflightMetadata = jest.fn();
const requireCurrentRootfsPreflightMetadata = jest.fn();
const writeRootfsPreflightMetadata = jest.fn();
const rsyncProgressReporter = jest.fn();
const spawn = jest.fn();
const podmanEnv = jest.fn();
const rm = jest.fn();
const writeFile = jest.fn();

jest.mock("@cocalc/backend/data", () => ({
  data: "/mnt/cocalc/data",
}));

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: (...args: any[]) => exists(...args),
}));

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: (...args: any[]) => executeCode(...args),
}));

jest.mock("@cocalc/backend/podman/env", () => ({
  podmanEnv: (...args: any[]) => podmanEnv(...args),
}));

jest.mock("fs/promises", () => ({
  rm: (...args: any[]) => rm(...args),
  writeFile: (...args: any[]) => writeFile(...args),
}));

jest.mock("@cocalc/util/reuse-in-flight", () => ({
  reuseInFlight: (fn: any) => fn,
}));

jest.mock("node:child_process", () => ({
  spawn: (...args: any[]) => spawn(...args),
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

jest.mock("./run/rsync-progress", () => ({
  PROGRESS_ARGS: [],
  rsyncProgressReporter: (...args: any[]) => rsyncProgressReporter(...args),
}));

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
    rsyncProgressReporter.mockResolvedValue(undefined);
    spawn.mockReturnValue({} as any);
    podmanEnv.mockReturnValue({ XDG_RUNTIME_DIR: "/tmp/podman-test" });
    rm.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
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
    expect(executeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "podman",
        args: ["image", "rm", "docker.io/library/alpine:latest"],
        env: { XDG_RUNTIME_DIR: "/tmp/podman-test" },
      }),
    );
  });

  it("marks raw OCI extracts as oci-extract ownership layout", async () => {
    exists.mockResolvedValue(false);
    pullImage.mockResolvedValue(undefined);
    preflightPulledOciImage.mockResolvedValue({
      distro_family: "rhel",
      package_manager: "dnf",
      shell: "/bin/bash",
      glibc: true,
      sudo_present: false,
      ca_certificates_present: false,
    });
    preflightRootfsInPlace.mockResolvedValue({
      version: 1,
      normalized_at: new Date().toISOString(),
      image: "quay.io/centos/centos:stream9",
      rootfs_path:
        "/mnt/cocalc/data/cache/images/quay.io%2Fcentos%2Fcentos%3Astream9",
      distro_family: "rhel",
      package_manager: "dnf",
      shell: "/bin/bash",
      glibc: true,
      sudo_present: false,
      ca_certificates_present: false,
    });
    executeCode.mockResolvedValue({ stdout: "{}", stderr: "", exit_code: 0 });

    const { extractBaseImage } = await import("./run/rootfs-base");
    await expect(extractBaseImage("quay.io/centos/centos:stream9")).resolves.toBe(
      "/mnt/cocalc/data/cache/images/quay.io%2Fcentos%2Fcentos%3Astream9",
    );

    expect(preflightRootfsInPlace).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "quay.io/centos/centos:stream9",
        ownershipSource: "oci-extract",
      }),
    );
  });
});
