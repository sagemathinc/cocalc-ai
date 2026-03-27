import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("@cocalc/project-runner/run/rootfs-base", () => ({
  imageCachePath: jest.fn(),
  inspectFilePath: jest.fn(),
}));

jest.mock("@cocalc/project-runner/run/rootfs", () => ({
  getRootfsMountpoint: jest.fn(),
  isMounted: jest.fn(),
}));

const rootfsBase = jest.requireMock("@cocalc/project-runner/run/rootfs-base");
const rootfs = jest.requireMock("@cocalc/project-runner/run/rootfs");

describe("rootfs manifest", () => {
  let tmpdir: string;

  beforeEach(async () => {
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "rootfs-manifest-"));
    rootfsBase.imageCachePath.mockReturnValue(tmpdir);
    rootfsBase.inspectFilePath.mockReturnValue(
      path.join(tmpdir, ".inspect.json"),
    );
    rootfs.getRootfsMountpoint.mockReturnValue(tmpdir);
    rootfs.isMounted.mockResolvedValue(true);
  });

  afterEach(async () => {
    jest.resetModules();
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  it("treats hardlinks as visible topology and distinguishes broken copies", async () => {
    await fs.mkdir(path.join(tmpdir, "dir"), { recursive: true });
    await fs.writeFile(path.join(tmpdir, "dir", "alpha.txt"), "alpha\n");
    await fs.link(
      path.join(tmpdir, "dir", "alpha.txt"),
      path.join(tmpdir, "dir", "alpha-link.txt"),
    );
    await fs.writeFile(path.join(tmpdir, "dir", "alpha-copy.txt"), "alpha\n");
    await fs.symlink(
      "alpha.txt",
      path.join(tmpdir, "dir", "alpha-symlink.txt"),
    );

    const { buildCachedRootfsManifest } = await import("./rootfs-manifest");
    const hardlinked = await buildCachedRootfsManifest("managed:image");

    await fs.unlink(path.join(tmpdir, "dir", "alpha-link.txt"));
    await fs.writeFile(path.join(tmpdir, "dir", "alpha-link.txt"), "alpha\n");

    const brokenCopy = await buildCachedRootfsManifest("managed:image");

    expect(hardlinked.entry_count).toBe(brokenCopy.entry_count);
    expect(hardlinked.regular_file_count).toBe(3);
    expect(hardlinked.symlink_count).toBe(1);
    expect(hardlinked.hardlink_group_count).toBe(1);
    expect(hardlinked.hardlink_member_count).toBe(2);
    expect(hardlinked.manifest_sha256).not.toBe(brokenCopy.manifest_sha256);
    expect(hardlinked.hardlink_sha256).not.toBe(brokenCopy.hardlink_sha256);
    expect(brokenCopy.hardlink_group_count).toBe(0);
    expect(brokenCopy.hardlink_member_count).toBe(0);
  });

  it("ignores root mountpoint mode differences", async () => {
    await fs.mkdir(path.join(tmpdir, "etc"), { recursive: true });
    await fs.writeFile(path.join(tmpdir, "etc", "issue"), "hello\n");

    const { buildCachedRootfsManifest } = await import("./rootfs-manifest");
    const before = await buildCachedRootfsManifest("managed:image");

    await fs.chmod(tmpdir, 0o775);
    const after = await buildCachedRootfsManifest("managed:image");

    expect(before.manifest_sha256).toBe(after.manifest_sha256);
    expect(before.hardlink_sha256).toBe(after.hardlink_sha256);
  });
});
