import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

jest.mock("./privileged-delete", () => {
  const actual = jest.requireActual("./privileged-delete");
  return {
    ...actual,
    runPrivilegedDelete: jest.fn(async () => {}),
  };
});

import { SandboxedFilesystem } from "./index";
import { runPrivilegedDelete } from "./privileged-delete";

describe("sandbox sudo delete", () => {
  it("routes home sudo rm through the privileged delete helper", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "sandbox-sudo-rm-"));
    const home = path.join(base, "home");
    const rootfs = path.join(base, "rootfs");
    const scratch = path.join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const fs = new SandboxedFilesystem(home, {
      rootfs,
      scratch,
      homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
    });

    await fs.rm("/home/user/.local/share/cocalc/rootfs", {
      recursive: true,
      force: true,
      sudo: true,
    });

    expect(runPrivilegedDelete).toHaveBeenCalledWith({
      command: "sandbox-rm",
      root: home,
      rel: ".local/share/cocalc/rootfs",
      recursive: true,
      force: true,
    });
  });

  it("routes scratch sudo rmdir through the privileged delete helper", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "sandbox-sudo-rmdir-"));
    const home = path.join(base, "home");
    const rootfs = path.join(base, "rootfs");
    const scratch = path.join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const fs = new SandboxedFilesystem(home, {
      rootfs,
      scratch,
      homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
    });

    await fs.rmdir("/scratch/tmp", { sudo: true });

    expect(runPrivilegedDelete).toHaveBeenCalledWith({
      command: "sandbox-rmdir",
      root: scratch,
      rel: "tmp",
      recursive: false,
      force: false,
    });
  });

  it("rejects sudo deletes against rootfs paths", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "sandbox-sudo-rootfs-"));
    const home = path.join(base, "home");
    const rootfs = path.join(base, "rootfs");
    const scratch = path.join(base, "scratch");
    await mkdir(home, { recursive: true });
    await mkdir(rootfs, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const fs = new SandboxedFilesystem(home, {
      rootfs,
      scratch,
      homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
    });

    await expect(
      fs.rm("/etc/passwd", { sudo: true, force: true }),
    ).rejects.toThrow("only supported in project home and /scratch");
  });
});
