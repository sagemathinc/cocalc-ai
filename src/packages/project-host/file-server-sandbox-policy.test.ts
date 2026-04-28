import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createProjectSandboxFilesystem } from "./file-server-sandbox-policy";

describe("file-server sandbox policy", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";

  it("keeps home writable while denying rootfs/scratch when mounts are missing", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-fs-policy-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs-missing");
    const scratch = join(base, "scratch-missing");
    await mkdir(home, { recursive: true });

    const fs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    await fs.writeFile("/home/user/home.txt", "home");
    await fs.writeFile("relative.txt", "relative");
    expect(await fs.readFile("/home/user/home.txt", "utf8")).toBe("home");
    expect(await fs.readFile("relative.txt", "utf8")).toBe("relative");
    await expect(fs.readFile("/root/home.txt", "utf8")).rejects.toThrow(
      "rootfs is not mounted; cannot access absolute path '/root/home.txt'. Start the workspace and try again.",
    );

    await expect(fs.writeFile("/tmp/rootfs.txt", "blocked")).rejects.toThrow(
      "rootfs is not mounted; cannot access absolute path '/tmp/rootfs.txt'. Start the workspace and try again.",
    );
    await expect(fs.writeFile("/scratch/data.txt", "blocked")).rejects.toThrow(
      "scratch is not mounted; cannot access absolute path '/scratch/data.txt'. Start the workspace and try again.",
    );
  });

  it("routes writes to home, rootfs, and scratch when mounts exist", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-fs-policy-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });

    const fs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
    });

    await fs.mkdir("/tmp");
    await fs.mkdir("/root");
    await fs.writeFile("/tmp/rootfs.txt", "rootfs");
    await fs.writeFile("/scratch/data.txt", "scratch");
    await fs.writeFile("/home/user/home.txt", "home");
    await fs.writeFile("/root/root-home.txt", "rootfs-root");

    expect(await readFile(join(rootfs, "tmp", "rootfs.txt"), "utf8")).toBe(
      "rootfs",
    );
    expect(await readFile(join(rootfs, "root", "root-home.txt"), "utf8")).toBe(
      "rootfs-root",
    );
    expect(await readFile(join(scratch, "data.txt"), "utf8")).toBe("scratch");
    expect(await readFile(join(home, "home.txt"), "utf8")).toBe("home");
    await expect(fs.readFile("/root/home.txt", "utf8")).rejects.toThrow();
    expect(await fs.readFile("/root/root-home.txt", "utf8")).toBe(
      "rootfs-root",
    );
  });

  it("routes snapshot rm to deleteSnapshot for runtime-home paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-fs-policy-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const deleteSnapshot = jest.fn(async () => {});

    const fs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
      deleteSnapshot,
    });

    await fs.rm("/home/user/.snapshots/2026-04-28T19:27:16.282Z", {
      recursive: true,
      force: true,
      sudo: true,
    });

    expect(deleteSnapshot).toHaveBeenCalledWith("2026-04-28T19:27:16.282Z");
  });

  it("rejects deleting nested files inside snapshots", async () => {
    const base = await mkdtemp(join(tmpdir(), "cocalc-fs-policy-"));
    const home = join(base, "home");
    const rootfs = join(base, "rootfs");
    const scratch = join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const deleteSnapshot = jest.fn(async () => {});

    const fs = createProjectSandboxFilesystem({
      project_id,
      home,
      rootfs,
      scratch,
      deleteSnapshot,
    });

    await expect(
      fs.rm("/home/user/.snapshots/2026-04-28T19:27:16.282Z/file.txt", {
        force: true,
      }),
    ).rejects.toThrow(
      "Snapshots are read-only. Delete the snapshot '2026-04-28T19:27:16.282Z' instead of files inside it",
    );
  });
});
