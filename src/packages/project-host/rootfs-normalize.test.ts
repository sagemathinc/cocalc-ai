import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const executeCode = jest.fn();

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
  };
});

describe("rootfs normalization metadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("records and reloads current normalization metadata", async () => {
    executeCode.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        distro_family: "debian",
        package_manager: "apt-get",
        shell: "/bin/bash",
        glibc: true,
        sudo: true,
        ca_certificates: true,
        curl: true,
        runtime_user: "user",
        runtime_uid: 1000,
        runtime_gid: 1000,
        runtime_home: "/home/user",
      }),
    });

    const mod = await import("../project-runner/run/rootfs-normalize");
    const tmpdir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rootfs-normalize-"),
    );
    try {
      const metadataPath = path.join(tmpdir, "normalized.json");
      const metadata = await mod.normalizeRootfsInPlace({
        image: "docker.io/library/ubuntu:24.04",
        rootfsPath: "/mnt/cocalc/data/cache/images/example",
      });
      await mod.writeRootfsNormalizationMetadata({
        metadataPath,
        metadata,
      });
      const loaded = await mod.loadRootfsNormalizationMetadata(metadataPath);
      expect(loaded).toMatchObject({
        version: mod.ROOTFS_NORMALIZER_VERSION,
        image: "docker.io/library/ubuntu:24.04",
        distro_family: "debian",
        package_manager: "apt-get",
        runtime_user: "user",
        runtime_home: "/home/user",
      });
      expect(() =>
        mod.requireCurrentRootfsNormalizationMetadata({
          image: "docker.io/library/ubuntu:24.04",
          metadataPath,
          metadata: loaded,
        }),
      ).not.toThrow();
      expect(executeCode).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "sudo",
          args: [
            "-n",
            "/usr/local/sbin/cocalc-runtime-storage",
            "normalize-rootfs",
            "/mnt/cocalc/data/cache/images/example",
          ],
        }),
      );
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true });
    }
  });

  it("rejects rootfs normalization output that does not satisfy the contract", async () => {
    executeCode.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        distro_family: "debian",
        package_manager: "apt-get",
        shell: "/bin/bash",
        glibc: true,
        sudo: true,
        ca_certificates: true,
        curl: true,
        runtime_user: "root",
        runtime_uid: 0,
        runtime_gid: 0,
        runtime_home: "/root",
      }),
    });

    const mod = await import("../project-runner/run/rootfs-normalize");
    await expect(
      mod.normalizeRootfsInPlace({
        image: "docker.io/library/ubuntu:24.04",
        rootfsPath: "/mnt/cocalc/data/cache/images/example",
      }),
    ).rejects.toThrow(/unexpected contract result/);
  });
});
