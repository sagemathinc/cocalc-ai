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

describe("rootfs preflight metadata", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("records and reloads current preflight metadata", async () => {
    executeCode.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        distro_family: "debian",
        package_manager: "apt-get",
        shell: "/bin/bash",
        glibc: true,
        sudo_present: false,
        ca_certificates_present: false,
      }),
    });

    const mod = await import("../project-runner/run/rootfs-normalize");
    const tmpdir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rootfs-normalize-"),
    );
    try {
      const metadataPath = path.join(tmpdir, "preflight.json");
      const metadata = await mod.preflightRootfsInPlace({
        image: "docker.io/library/ubuntu:24.04",
        rootfsPath: "/mnt/cocalc/data/cache/images/example",
      });
      await mod.writeRootfsPreflightMetadata({
        metadataPath,
        metadata,
      });
      const loaded = await mod.loadRootfsPreflightMetadata(metadataPath);
      expect(loaded).toMatchObject({
        version: mod.ROOTFS_PREFLIGHT_VERSION,
        image: "docker.io/library/ubuntu:24.04",
        distro_family: "debian",
        package_manager: "apt-get",
        sudo_present: false,
        ca_certificates_present: false,
      });
      expect(() =>
        mod.requireCurrentRootfsPreflightMetadata({
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

  it("rejects rootfs preflight output that does not satisfy the bootstrap requirements", async () => {
    executeCode.mockResolvedValue({
      stdout: JSON.stringify({
        ok: true,
        distro_family: "debian",
        package_manager: "apt-get",
        shell: "/bin/bash",
        glibc: true,
        sudo_present: "yes",
        ca_certificates_present: false,
      }),
    });

    const mod = await import("../project-runner/run/rootfs-normalize");
    await expect(
      mod.preflightRootfsInPlace({
        image: "docker.io/library/ubuntu:24.04",
        rootfsPath: "/mnt/cocalc/data/cache/images/example",
      }),
    ).rejects.toThrow(/unexpected result/);
  });

  it("accepts preflight output with package-manager log lines before the final JSON", async () => {
    executeCode.mockResolvedValue({
      stdout: [
        "Hit:1 http://archive.ubuntu.com/ubuntu noble InRelease",
        "Reading package lists...",
        JSON.stringify({
          ok: true,
          distro_family: "debian",
          package_manager: "apt-get",
          shell: "/bin/bash",
          glibc: true,
          sudo_present: true,
          ca_certificates_present: true,
        }),
      ].join("\n"),
    });

    const mod = await import("../project-runner/run/rootfs-normalize");
    await expect(
      mod.preflightRootfsInPlace({
        image: "docker.io/library/buildpack-deps:noble-scm",
        rootfsPath: "/mnt/cocalc/data/cache/images/example",
      }),
    ).resolves.toMatchObject({
      image: "docker.io/library/buildpack-deps:noble-scm",
      distro_family: "debian",
      package_manager: "apt-get",
      sudo_present: true,
    });
  });
});
