import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rmSync, symlinkSync } from "node:fs";
import { __test__, runPrivilegedRmHelper } from "./privileged-rm-helper";

describe("privileged-rm-helper", () => {
  it("removes a file beneath the specified root", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "project-host-privileged-rm-helper-"),
    );
    await mkdir(path.join(root, "dir"), { recursive: true });
    await writeFile(path.join(root, "dir", "file.txt"), "x");

    runPrivilegedRmHelper([
      "rm",
      "--root",
      root,
      "--path",
      "dir/file.txt",
      "--force",
    ]);

    await expect(
      readFile(path.join(root, "dir", "file.txt"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("does not remove data outside the root when the target is swapped to a symlink", async () => {
    const base = await mkdtemp(
      path.join(os.tmpdir(), "project-host-privileged-rm-helper-race-"),
    );
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(path.join(root, "tree"), { recursive: true });
    await writeFile(path.join(root, "tree", "inside.txt"), "inside");
    await writeFile(path.join(outside, "secret.txt"), "secret");

    const { SandboxRoot } = require("@cocalc/openat2") as {
      SandboxRoot: new (root: string) => { rm: (...args: any[]) => void };
    };
    const originalRm = SandboxRoot.prototype.rm;
    SandboxRoot.prototype.rm = function (
      this: { rm: (...args: any[]) => void },
      rel: string,
      recursive?: boolean,
      force?: boolean,
    ) {
      rmSync(path.join(root, "tree"), { recursive: true, force: true });
      symlinkSync(outside, path.join(root, "tree"));
      return originalRm.call(this, rel, recursive, force);
    };
    try {
      try {
        runPrivilegedRmHelper([
          "rm",
          "--root",
          root,
          "--path",
          "tree",
          "--recursive",
        ]);
      } catch (err: any) {
        expect(err?.message ?? "").toContain("outside");
      }
    } finally {
      SandboxRoot.prototype.rm = originalRm;
    }

    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe(
      "secret",
    );
  });

  it("rejects absolute or escaping helper paths", () => {
    expect(() =>
      __test__.parseArgs(["rm", "--root", "/tmp/root", "--path", "/etc"]),
    ).toThrow("relative");
    expect(() =>
      __test__.parseArgs(["rm", "--root", "/tmp/root", "--path", "../etc"]),
    ).toThrow("beneath root");
  });
});
