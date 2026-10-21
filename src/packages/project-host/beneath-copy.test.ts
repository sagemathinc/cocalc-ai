/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execFileSync } from "node:child_process";

const mockNativeFsTask = jest.fn((fn: () => Promise<unknown>) => fn());
jest.mock("@cocalc/backend/sandbox/native-fs-limit", () => ({
  runNativeFsTask: (fn: () => Promise<unknown>) => mockNativeFsTask(fn),
}));

import { copyBeneath, kindBeneath, rmBeneath } from "./beneath-copy";

describe("copyBeneath", () => {
  let base: string;
  let src: string; // the source project's home
  let dest: string; // the destination project's home
  let outside: string; // host files neither project may reach

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "beneath-copy-"));
    src = join(base, "src");
    dest = join(base, "dest");
    outside = join(base, "outside");
    await mkdir(src);
    await mkdir(dest);
    await mkdir(outside);
    await writeFile(join(outside, "secret"), "host secret");
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const copy = (
    srcPath: string,
    destPath: string,
    options: Parameters<typeof copyBeneath>[0]["options"] = { recursive: true },
  ) =>
    copyBeneath({
      src: { root: src, path: srcPath },
      dest: { root: dest, path: destPath },
      options,
    });

  async function outsideUnchanged() {
    expect((await readdir(outside)).sort()).toEqual(["secret"]);
    expect(await readFile(join(outside, "secret"), "utf8")).toBe("host secret");
  }

  async function noTempFiles(dir: string) {
    const names = await readdir(dir, { recursive: true });
    expect(names.filter((n) => `${n}`.includes(".cocalc-copy-"))).toEqual([]);
  }

  it("copies a tree, keeping symlinks as links and modes", async () => {
    await mkdir(join(src, "a/b"), { recursive: true });
    await writeFile(join(src, "a/one.txt"), "one");
    await writeFile(join(src, "a/b/run.sh"), "#!/bin/sh");
    await chmod(join(src, "a/b/run.sh"), 0o755);
    await symlink("one.txt", join(src, "a/link"));

    await copy("a", "copied/a");

    expect(await readFile(join(dest, "copied/a/one.txt"), "utf8")).toBe("one");
    expect((await stat(join(dest, "copied/a/b/run.sh"))).mode & 0o777).toBe(
      0o755,
    );
    expect(await readlink(join(dest, "copied/a/link"))).toBe("one.txt");
    await noTempFiles(dest);
  });

  it("copies a single file to exactly the destination", async () => {
    await writeFile(join(src, "f"), "data");
    await copy("f", "g", {});
    expect(await readFile(join(dest, "g"), "utf8")).toBe("data");
  });

  it("merges into an existing directory, replacing files", async () => {
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d/new"), "new");
    await writeFile(join(src, "d/both"), "from source");
    await mkdir(join(dest, "d"));
    await writeFile(join(dest, "d/both"), "old");
    await writeFile(join(dest, "d/kept"), "kept");

    await copy("d", "d");

    expect(await readFile(join(dest, "d/new"), "utf8")).toBe("new");
    expect(await readFile(join(dest, "d/both"), "utf8")).toBe("from source");
    expect(await readFile(join(dest, "d/kept"), "utf8")).toBe("kept");
  });

  it("keeps existing files without force, and can refuse an existing target", async () => {
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d/both"), "from source");
    await writeFile(join(src, "d/new"), "new");
    await mkdir(join(dest, "d"));
    await writeFile(join(dest, "d/both"), "old");

    await copy("d", "d", { recursive: true, force: false });
    expect(await readFile(join(dest, "d/both"), "utf8")).toBe("old");
    expect(await readFile(join(dest, "d/new"), "utf8")).toBe("new");

    await expect(
      copy("d", "d", { recursive: true, force: false, errorOnExist: true }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
  });

  it("refuses a destination whose parent is a planted symlink, even a new path", async () => {
    await writeFile(join(src, "f"), "attacker data");
    await symlink(outside, join(dest, "evil"));

    await expect(copy("f", "evil/planted", {})).rejects.toThrow(/ELOOP/);
    await expect(copy("f", "evil/x/y/planted", {})).rejects.toThrow(/ELOOP/);

    await outsideUnchanged();
  });

  it("refuses a source path through a planted symlink", async () => {
    await symlink(outside, join(src, "evil"));

    await expect(copy("evil/secret", "stolen", {})).rejects.toThrow(/ELOOP/);
    await copy("evil", "stolen-link"); // the link itself, not what it names

    expect(await readdir(dest)).toEqual(["stolen-link"]);
    expect(await readlink(join(dest, "stolen-link"))).toBe(outside);
    await outsideUnchanged();
  });

  it("copies a symlink inside the tree as a link, never its target's data", async () => {
    await mkdir(join(src, "d"));
    await symlink(join(outside, "secret"), join(src, "d/leak"));

    await copy("d", "d");

    expect((await lstat(join(dest, "d/leak"))).isSymbolicLink()).toBe(true);
    await outsideUnchanged();
  });

  it("replaces a symlink at the destination instead of writing through it", async () => {
    await writeFile(join(src, "f"), "data");
    await symlink(join(outside, "secret"), join(dest, "f"));
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d/x"), "x");
    await symlink(outside, join(dest, "d"));

    await copy("f", "f", {});
    await copy("d", "d");

    expect(await readFile(join(dest, "f"), "utf8")).toBe("data");
    expect((await lstat(join(dest, "f"))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(dest, "d"))).isDirectory()).toBe(true);
    expect(await readFile(join(dest, "d/x"), "utf8")).toBe("x");
    await outsideUnchanged();
  });

  it("refuses to dereference symlinks on the host", async () => {
    await symlink(outside, join(src, "evil"));
    await expect(
      copy("evil", "x", { recursive: true, dereference: true }),
    ).rejects.toMatchObject({ code: "ENOTSUP" });
    await outsideUnchanged();
  });

  it("drops setuid and setgid bits", async () => {
    await writeFile(join(src, "tool"), "binary");
    await chmod(join(src, "tool"), 0o6755);
    await copy("tool", "tool", {});
    expect((await stat(join(dest, "tool"))).mode & 0o7777).toBe(0o755);
  });

  it("preserves timestamps when asked", async () => {
    await writeFile(join(src, "f"), "data");
    const when = new Date("2020-01-02T03:04:05Z");
    await utimes(join(src, "f"), when, when);
    await copy("f", "f", { preserveTimestamps: true });
    expect((await stat(join(dest, "f"))).mtime.getTime()).toBe(when.getTime());
  });

  it("requires recursive for a directory and refuses copying into itself", async () => {
    await mkdir(join(src, "d"));
    await expect(copy("d", "d", {})).rejects.toMatchObject({ code: "EISDIR" });
    await expect(
      copyBeneath({
        src: { root: src, path: "d" },
        dest: { root: src, path: "d/inner" },
        options: { recursive: true },
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("reports what is at a path without following links", async () => {
    await symlink(outside, join(dest, "evil"));
    await mkdir(join(dest, "d"));
    expect(await kindBeneath(dest, "d")).toBe("dir");
    expect(await kindBeneath(dest, "missing")).toBe("missing");
    expect(await kindBeneath(dest, "evil")).toBe("symlink");
    await expect(kindBeneath(dest, "evil/secret")).rejects.toThrow(/ELOOP/);
  });

  it("removes beneath the root without following a symlinked parent", async () => {
    await symlink(outside, join(dest, "evil"));
    await expect(rmBeneath(dest, "evil/secret")).rejects.toThrow(/ELOOP/);
    await rmBeneath(dest, "evil");
    expect(await readdir(dest)).toEqual([]);
    await outsideUnchanged();
  });

  it("stops between entries when the checkpoint throws", async () => {
    await mkdir(join(src, "d"));
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(src, "d", name), name);
    }
    let calls = 0;
    await expect(
      copy("d", "d", {
        recursive: true,
        checkpoint: () => {
          // Called for each entry and again before each file's data moves:
          // d, a, a's data, then b stops the copy.
          calls += 1;
          if (calls > 3) throw new Error("deadline passed");
        },
      }),
    ).rejects.toThrow("deadline passed");
    expect((await readdir(join(dest, "d"))).length).toBe(1);
    await noTempFiles(dest);
  });

  it("never lists a directory that a swapped-in symlink points at", async () => {
    // Simulates the race: the path is redirected exactly when it is opened.
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d", "mine"), "mine");
    await writeFile(join(outside, "mine"), "not copied");
    const nodeFs = require("node:fs");
    const realOpen = nodeFs.openSync;
    const spy = jest
      .spyOn(nodeFs, "openSync")
      .mockImplementation((p: any, ...rest: any[]) =>
        realOpen(p === join(src, "d") ? outside : p, ...rest),
      );
    try {
      await expect(copy("d", "d")).rejects.toThrow(/changed while copying/);
    } finally {
      spy.mockRestore();
    }
    expect(await readdir(join(dest, "d"))).toEqual([]);
  });

  it("refuses to copy a file or directory onto itself", async () => {
    await writeFile(join(src, "a"), "a");
    await link(join(src, "a"), join(src, "b"));
    await expect(
      copyBeneath({
        src: { root: src, path: "a" },
        dest: { root: src, path: "b" },
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EINVAL" });
    expect(await readFile(join(src, "a"), "utf8")).toBe("a");

    // The same directory under another name for its root.
    await mkdir(join(src, "d"));
    await symlink(src, join(base, "alias"));
    await expect(
      copyBeneath({
        src: { root: src, path: "d" },
        dest: { root: join(base, "alias"), path: "d" },
        options: { recursive: true },
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("keeps a destination that appears during a no-clobber copy", async () => {
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d", "f"), "from source");
    let created = false;
    // The destination's owner creates the file while the copy is running.
    const appear = () => {
      if (created) return;
      created = true;
      require("node:fs").mkdirSync(join(dest, "d"), { recursive: true });
      require("node:fs").writeFileSync(join(dest, "d", "f"), "theirs");
    };
    await copy("d", "d", { recursive: true, force: false, checkpoint: appear });
    expect(await readFile(join(dest, "d", "f"), "utf8")).toBe("theirs");

    // With errorOnExist, a destination that appears while the data is being
    // copied (after every check) fails the copy at placement.
    await writeFile(join(src, "g"), "from source");
    mockNativeFsTask.mockImplementationOnce((fn) => {
      require("node:fs").writeFileSync(join(dest, "g"), "theirs");
      return fn();
    });
    await expect(
      copy("g", "g", { force: false, errorOnExist: true }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
    expect(await readFile(join(dest, "g"), "utf8")).toBe("theirs");
  });

  it("stops once its timeout has passed", async () => {
    await mkdir(join(src, "d"));
    for (const name of ["a", "b", "c"]) {
      await writeFile(join(src, "d", name), name);
    }
    const start = Date.now();
    let calls = 0;
    const now = jest
      .spyOn(Date, "now")
      .mockImplementation(() => start + 600 * calls++);
    try {
      await expect(
        copy("d", "d", { recursive: true, timeout: 1000 }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    } finally {
      now.mockRestore();
    }
    expect((await readdir(join(dest, "d"))).length).toBeLessThan(3);
  });

  it("copies file data under the shared bound on native fs work", async () => {
    mockNativeFsTask.mockClear();
    await writeFile(join(src, "f"), "data");
    await copy("f", "f", {});
    expect(mockNativeFsTask).toHaveBeenCalledTimes(1);
  });

  it("fails on a special file instead of copying only part of a tree", async () => {
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d", "f"), "f");
    execFileSync("mkfifo", [join(src, "d", "pipe")]);
    await expect(copy("d", "d")).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("copies to a name of the maximum length", async () => {
    const long = "n".repeat(255);
    await writeFile(join(src, "f"), "data");
    await copy("f", long, {});
    expect(await readFile(join(dest, long), "utf8")).toBe("data");
    await noTempFiles(dest);
  });

  it("treats a backslash as part of a name", async () => {
    await writeFile(join(src, "a\\b"), "data");
    await copy("a\\b", "c\\d", {});
    expect(await readFile(join(dest, "c\\d"), "utf8")).toBe("data");
  });

  it("does not start a copy whose deadline passed while it waited for a slot", async () => {
    await writeFile(join(src, "f"), "data");
    let t = 0;
    const now = jest.spyOn(Date, "now").mockImplementation(() => t);
    mockNativeFsTask.mockImplementationOnce((fn) => {
      t = 2000; // a long wait for the shared slot
      return fn();
    });
    try {
      await expect(copy("f", "f", { timeout: 1000 })).rejects.toMatchObject({
        code: "ETIMEDOUT",
      });
    } finally {
      now.mockRestore();
    }
    expect(await readdir(dest)).toEqual([]);
  });

  it("reports a destination that appears before the copy reaches it", async () => {
    await mkdir(join(src, "d"));
    await writeFile(join(src, "d", "mine"), "mine");
    const appear = (make: () => void) => {
      let done = false;
      return () => {
        if (!done) {
          done = true;
          make();
        }
      };
    };
    await expect(
      copy("d", "d", {
        recursive: true,
        force: false,
        errorOnExist: true,
        checkpoint: appear(() => {
          require("node:fs").mkdirSync(join(dest, "d"));
          require("node:fs").writeFileSync(join(dest, "d", "theirs"), "x");
        }),
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
    expect(await readdir(join(dest, "d"))).toEqual(["theirs"]);

    // A file source whose destination appears as a directory: also EEXIST.
    await writeFile(join(src, "f"), "f");
    await expect(
      copy("f", "f", {
        force: false,
        errorOnExist: true,
        checkpoint: appear(() => require("node:fs").mkdirSync(join(dest, "f"))),
      }),
    ).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" });
  });

  it("keeps the sticky bit of a directory", async () => {
    await mkdir(join(src, "shared"));
    await chmod(join(src, "shared"), 0o1777);
    await copy("shared", "shared");
    expect((await stat(join(dest, "shared"))).mode & 0o7777).toBe(0o1777);
  });
});
