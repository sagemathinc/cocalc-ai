import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBundleVersionInfo } from "./project-host-software";

describe("project-host local software versioning", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "project-host-software-"));
  });

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prefers project-host build identity over tarball mtime", async () => {
    const buildDir = join(root, "project-host", "build");
    const bundleDir = join(buildDir, "bundle");
    await mkdir(bundleDir, { recursive: true });
    const bundlePath = join(buildDir, "bundle-linux.tar.xz");
    await writeFile(bundlePath, "bundle");
    await writeFile(
      join(bundleDir, "build-identity.json"),
      JSON.stringify(
        {
          build_id: "20260503T191857Z-1d5c108b5bbf-dirty-e3b0c442",
          built_at: "2026-05-03T19:18:57.000Z",
        },
        null,
        2,
      ),
    );
    const info = await getBundleVersionInfo(bundlePath, "project-host");
    expect(info.version).toBe("20260503T191857Z-1d5c108b5bbf-dirty-e3b0c442");
    expect(info.builtAt).toBe("2026-05-03T19:18:57.000Z");
  });

  it("keeps mtime-based versioning for non-project-host artifacts", async () => {
    const buildDir = join(root, "project", "build");
    await mkdir(buildDir, { recursive: true });
    const bundlePath = join(buildDir, "bundle-linux.tar.xz");
    await writeFile(bundlePath, "bundle");
    const info = await getBundleVersionInfo(bundlePath, "project");
    expect(info.version).toMatch(/^\d+$/);
  });
});
