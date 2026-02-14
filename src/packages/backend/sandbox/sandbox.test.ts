import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "path";
import { make_patch } from "@cocalc/util/dmp";
import { delay } from "awaiting";

let tempDir;
beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "cocalc"));
});

async function expectRejectsWithError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw err;
  }
  throw new Error("Expected promise to reject with Error");
}

describe("test using the filesystem sandbox to do a few standard things", () => {
  let fs;
  it("creates and reads file", async () => {
    await mkdir(join(tempDir, "test-1"));
    fs = new SandboxedFilesystem(join(tempDir, "test-1"));
    await fs.writeFile("a", "hi");
    const r = await fs.readFile("a", "utf8");
    expect(r).toEqual("hi");
    expect(fs.unsafeMode).toBe(false);
  });

  it("truncate file", async () => {
    await fs.writeFile("b", "hello");
    await fs.truncate("b", 4);
    const r = await fs.readFile("b", "utf8");
    expect(r).toEqual("hell");
  });
});

describe("baseline mutator parity behavior", () => {
  let fs;
  it("creates sandbox", async () => {
    await mkdir(join(tempDir, "test-mutators"));
    fs = new SandboxedFilesystem(join(tempDir, "test-mutators"));
  });

  it("supports write overwrite and append", async () => {
    await fs.writeFile("a.txt", "alpha");
    expect(await fs.readFile("a.txt", "utf8")).toBe("alpha");

    await fs.writeFile("a.txt", "beta");
    expect(await fs.readFile("a.txt", "utf8")).toBe("beta");

    await fs.appendFile("a.txt", "-tail");
    expect(await fs.readFile("a.txt", "utf8")).toBe("beta-tail");
  });

  it("supports copy, rename, move and unlink", async () => {
    await fs.copyFile("a.txt", "copy.txt");
    expect(await fs.readFile("copy.txt", "utf8")).toBe("beta-tail");

    await fs.rename("copy.txt", "renamed.txt");
    expect(await fs.exists("copy.txt")).toBe(false);
    expect(await fs.readFile("renamed.txt", "utf8")).toBe("beta-tail");

    await fs.mkdir("dst");
    await fs.move("renamed.txt", "dst/moved.txt");
    expect(await fs.exists("renamed.txt")).toBe(false);
    expect(await fs.readFile("dst/moved.txt", "utf8")).toBe("beta-tail");

    await fs.unlink("dst/moved.txt");
    expect(await fs.exists("dst/moved.txt")).toBe(false);
  });

  it("supports rm for single path and array path arguments", async () => {
    await fs.writeFile("x.txt", "x");
    await fs.writeFile("y.txt", "y");
    await fs.rm(["x.txt", "y.txt"]);
    expect(await fs.exists("x.txt")).toBe(false);
    expect(await fs.exists("y.txt")).toBe(false);

    await fs.mkdir("tmp");
    await fs.writeFile("tmp/z.txt", "z");
    await fs.rm("tmp", { recursive: true });
    expect(await fs.exists("tmp")).toBe(false);
  });
});

describe("make various attempts to break out of the sandbox", () => {
  let fs;
  it("creates sandbox", async () => {
    await mkdir(join(tempDir, "test-2"));
    fs = new SandboxedFilesystem(join(tempDir, "test-2"));
    await fs.writeFile("x", "hi");
  });

  it("obvious first attempt to escape fails", async () => {
    const v = await fs.readdir("..");
    expect(v).toEqual(["x"]);
  });

  it("obvious first attempt to escape fails", async () => {
    const v = await fs.readdir("a/../..");
    expect(v).toEqual(["x"]);
  });

  it("another attempt", async () => {
    await fs.copyFile("/x", "/tmp");
    const v = await fs.readdir("a/../..");
    expect(v).toEqual(["tmp", "x"]);

    const r = await fs.readFile("tmp", "utf8");
    expect(r).toEqual("hi");
  });
});

describe("test watching a file and a folder in the sandbox", () => {
  let fs;
  it("creates sandbox", async () => {
    await mkdir(join(tempDir, "test-watch"));
    fs = new SandboxedFilesystem(join(tempDir, "test-watch"));
  });

  it("watches the file x for changes", async () => {
    await fs.writeFile("x", "hi");
    const w = await fs.watch("x");
    await fs.appendFile("x", " there");
    const x = await w.next();
    expect(x).toEqual({
      // filename is relative to the path of the file, so
      // for watching a single file it is empty
      value: { event: "change", filename: "" },
      done: false,
    });
    w.end();
  });

  it("the maxQueue parameter limits the number of queue events", async () => {
    await fs.writeFile("x", "hi");
    const w = await fs.watch("x", {
      maxQueue: 2,
      stabilityThreshold: 20,
      pollInterval: 10,
    });
    expect(w.queueSize()).toBe(0);
    // make many changes
    await fs.appendFile("x", "0");
    await delay(100);
    await fs.appendFile("x", "0");
    await delay(100);
    await fs.appendFile("x", "0");
    await delay(100);
    await fs.appendFile("x", "0");
    await delay(100);
    // there will only be 2 available:
    expect(w.queueSize()).toBe(2);
    const x0 = await w.next();
    expect(x0).toEqual({
      value: { event: "change", filename: "" },
      done: false,
    });
    const x1 = await w.next();
    expect(x1).toEqual({
      value: { event: "change", filename: "" },
      done: false,
    });
    // one more next would hang...
    expect(w.queueSize()).toBe(0);
    w.end();
  });

  it("maxQueue with overflow throw", async () => {
    await fs.writeFile("x", "hi");
    const w = await fs.watch("x", {
      maxQueue: 2,
      overflow: "throw",
      stabilityThreshold: 0,
      pollInterval: 0,
    });
    await fs.appendFile("x", "0");
    await delay(100);
    await fs.appendFile("x", "0");
    await delay(100);
    await fs.appendFile("x", "0");
    await delay(100);
    try {
      await w.next();
      expect(false).toBe(true);
    } catch (err) {
      expect(`${err}`).toContain("maxQueue");
    }
    w.end();
  });

  it("AbortController works", async () => {
    const ac = new AbortController();
    const { signal } = ac;
    await fs.writeFile("x", "hi");
    const w = await fs.watch("x", {
      signal,
      pollInterval: 0,
      stabilityThreshold: 0,
    });
    await fs.appendFile("x", "0");
    const e = await w.next();
    expect(e.done).toBe(false);

    // now abort
    ac.abort();
    const { done } = await w.next();
    expect(done).toBe(true);
  });

  it("watches a directory", async () => {
    await fs.mkdir("folder");
    const w = await fs.watch("folder", {
      pollInterval: 0,
      stabilityThreshold: 0,
    });

    await fs.writeFile("folder/x", "hi");
    expect(await w.next()).toEqual({
      done: false,
      value: { event: "add", filename: "x" },
    });
    await fs.appendFile("folder/x", "xxx");
    expect(await w.next()).toEqual({
      done: false,
      value: { event: "change", filename: "x" },
    });

    await fs.writeFile("folder/z", "there");
    expect(await w.next()).toEqual({
      done: false,
      value: { event: "add", filename: "z" },
    });

    await fs.unlink("folder/z");
    expect(await w.next()).toEqual({
      done: false,
      value: { event: "unlink", filename: "z" },
    });
    w.end();
  });

  it("create-write then unlink emits unlink (allowing optional intermediate change)", async () => {
    await fs.mkdir("folder-regression");
    const w = await fs.watch("folder-regression", {
      pollInterval: 0,
      stabilityThreshold: 0,
    });

    await fs.writeFile("folder-regression/new.txt", "there");
    expect(await w.next()).toEqual({
      done: false,
      value: { event: "add", filename: "new.txt" },
    });

    // Filesystem watcher behavior can include an intermediate "change" event
    // after "add" on some runs/platforms. If present, consume it so we can
    // assert the core contract: unlink is emitted for the file.
    await delay(60);
    if (w.queueSize() > 0) {
      expect(await w.next()).toEqual({
        done: false,
        value: { event: "change", filename: "new.txt" },
      });
    }

    await fs.unlink("folder-regression/new.txt");
    let next = await w.next();
    if (next.value?.event === "change") {
      next = await w.next();
    }
    expect(next).toEqual({
      done: false,
      value: { event: "unlink", filename: "new.txt" },
    });
    w.end();
  });
});

describe("patch write support", () => {
  let fs;
  const filename = "patched.txt";

  it("creates sandbox", async () => {
    await mkdir(join(tempDir, "test-patch"));
    fs = new SandboxedFilesystem(join(tempDir, "test-patch"));
  });

  it("applies patch when base hash matches", async () => {
    const original = "hello world";
    await fs.writeFile(filename, original);
    const updated = "hello brave new world";
    const patch = make_patch(original, updated);
    const sha = createHash("sha256").update(original, "utf8").digest("hex");
    await fs.writeFile(filename, { patch, sha256: sha });
    const result = await fs.readFile(filename, "utf8");
    expect(result).toBe(updated);
  });

  it("rejects patch when base hash mismatches", async () => {
    const wrongBase = "abc";
    const wrongSha = createHash("sha256")
      .update(wrongBase, "utf8")
      .digest("hex");
    const patch = make_patch(wrongBase, `${wrongBase}d`);
    try {
      await fs.writeFile(filename, { patch, sha256: wrongSha });
      throw new Error("expected mismatch error");
    } catch (err: any) {
      expect(err.code).toBe("ETAG_MISMATCH");
    }
  });
});

describe("unsafe mode sandbox", () => {
  let fs;
  it("creates and reads file", async () => {
    await mkdir(join(tempDir, "test-unsafe"));
    fs = new SandboxedFilesystem(join(tempDir, "test-unsafe"), {
      unsafeMode: true,
    });
    expect(fs.unsafeMode).toBe(true);
    await fs.writeFile("a", "hi");
    const r = await fs.readFile("a", "utf8");
    expect(r).toEqual("hi");
  });

  it("directly create a dangerous file that is a symlink outside of the sandbox -- this should work", async () => {
    await writeFile(join(tempDir, "password"), "s3cr3t");
    await symlink(
      join(tempDir, "password"),
      join(tempDir, "test-unsafe", "danger"),
    );
    const s = await readFile(join(tempDir, "test-unsafe", "danger"), "utf8");
    expect(s).toBe("s3cr3t");
  });

  it("can **UNSAFELY** read the symlink content via the api", async () => {
    expect(await fs.readFile("danger", "utf8")).toBe("s3cr3t");
  });
});

describe("safe mode sandbox", () => {
  let fs;
  it("creates and reads file", async () => {
    await mkdir(join(tempDir, "test-safe"));
    fs = new SandboxedFilesystem(join(tempDir, "test-safe"), {
      unsafeMode: false,
    });
    expect(fs.unsafeMode).toBe(false);
    expect(fs.readonly).toBe(false);
    await fs.writeFile("a", "hi");
    const r = await fs.readFile("a", "utf8");
    expect(r).toEqual("hi");
  });

  it("directly create a dangerous file that is a symlink outside of the sandbox -- this should work", async () => {
    await writeFile(join(tempDir, "password"), "s3cr3t");
    await symlink(
      join(tempDir, "password"),
      join(tempDir, "test-safe", "danger"),
    );
    const s = await readFile(join(tempDir, "test-safe", "danger"), "utf8");
    expect(s).toBe("s3cr3t");
  });

  it("cannot read the symlink content via the api", async () => {
    await expect(async () => {
      await fs.readFile("danger", "utf8");
    }).rejects.toThrow("outside of sandbox");
  });
});

describe("safe mode mutator escape checks", () => {
  let fs;
  const outsideFile = () => join(tempDir, "mutator-outside-secret.txt");

  it("creates sandbox and outside targets", async () => {
    await mkdir(join(tempDir, "test-safe-mutator-escapes"));
    fs = new SandboxedFilesystem(join(tempDir, "test-safe-mutator-escapes"), {
      unsafeMode: false,
    });
    await writeFile(outsideFile(), "s3cr3t");
    await fs.writeFile("inside.txt", "inside");
    await symlink(outsideFile(), join(tempDir, "test-safe-mutator-escapes", "escape-link"));
  });

  it("blocks unlink/rm on symlink that resolves outside sandbox", async () => {
    await expect(fs.unlink("escape-link")).rejects.toThrow("outside of sandbox");
    await expect(fs.rm("escape-link")).rejects.toThrow("outside of sandbox");
  });

  it("blocks rename/move/copyFile when source resolves outside sandbox", async () => {
    await expect(fs.rename("escape-link", "x")).rejects.toThrow("outside of sandbox");
    await expect(fs.move("escape-link", "x")).rejects.toThrow("outside of sandbox");
    await expect(fs.copyFile("escape-link", "copied.txt")).rejects.toThrow(
      "outside of sandbox",
    );
  });

  it("blocks rename/move when destination symlink resolves outside sandbox", async () => {
    await symlink(outsideFile(), join(tempDir, "test-safe-mutator-escapes", "escape-dest"));
    await expect(fs.rename("inside.txt", "escape-dest")).rejects.toThrow(
      "outside of sandbox",
    );
    await expect(fs.move("inside.txt", "escape-dest")).rejects.toThrow(
      "outside of sandbox",
    );
  });
});

describe("read only sandbox", () => {
  let fs;
  it("creates and reads file", async () => {
    await mkdir(join(tempDir, "test-ro"));
    fs = new SandboxedFilesystem(join(tempDir, "test-ro"), {
      readonly: true,
    });
    expect(fs.readonly).toBe(true);
    await expect(async () => {
      await fs.writeFile("a", "hi");
    }).rejects.toThrow("permission denied -- read only filesystem");
    try {
      await fs.writeFile("a", "hi");
    } catch (err) {
      expect(err.code).toEqual("EACCES");
    }
  });
});

describe("rootfs option sandbox", () => {
  let fs;
  let home: string;
  let rootfs: string;
  let scratch: string;

  it("fails absolute non-home operations when rootfs is missing", async () => {
    home = join(tempDir, "test-rootfs-home");
    rootfs = join(tempDir, "test-rootfs-missing");
    await mkdir(home);
    fs = new SandboxedFilesystem(home, { rootfs });
    const err = await expectRejectsWithError(fs.writeFile("/alpha.txt", "from-home"));
    expect(err.message).toContain(
      "rootfs is not mounted; cannot access absolute path '/alpha.txt'. Start the workspace and try again.",
    );
    expect(err.message).not.toContain(rootfs);
    await fs.writeFile("/root/home-ok.txt", "ok");
    await fs.writeFile("relative-ok.txt", "ok");
    expect(await fs.readFile("/root/home-ok.txt", "utf8")).toBe("ok");
    expect(await fs.readFile("relative-ok.txt", "utf8")).toBe("ok");
  });

  it("does not leak mount paths when scratch is missing", async () => {
    const secretScratchPath = join(tempDir, "very-secret-scratch-mount");
    const fsMissingScratch = new SandboxedFilesystem(home, {
      rootfs,
      scratch: secretScratchPath,
    });
    const err = await expectRejectsWithError(
      fsMissingScratch.writeFile("/scratch/blocked.txt", "blocked"),
    );
    expect(err.message).toContain(
      "scratch is not mounted; cannot access absolute path '/scratch/blocked.txt'. Start the workspace and try again.",
    );
    expect(err.message).not.toContain(secretScratchPath);
  });

  it("switches to rootfs path once rootfs exists", async () => {
    await mkdir(rootfs, { recursive: true });
    await fs.mkdir("/tmp");
    await fs.writeFile("/tmp/from-root.txt", "from-root");
    expect(await fs.readFile("/tmp/from-root.txt", "utf8")).toBe("from-root");
    expect(await readFile(join(rootfs, "tmp", "from-root.txt"), "utf8")).toBe(
      "from-root",
    );
    await expect(readFile(join(home, "tmp", "from-root.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps /root and relative paths mapped to home path when rootfs exists", async () => {
    await fs.writeFile("/root/home-abs.txt", "from-home-abs");
    await fs.writeFile("home-rel.txt", "from-home-rel");
    expect(await fs.readFile("/root/home-abs.txt", "utf8")).toBe("from-home-abs");
    expect(await fs.readFile("home-rel.txt", "utf8")).toBe("from-home-rel");
    const rootListing = (await fs.readdir("/root")) as string[];
    expect(rootListing).toContain("home-abs.txt");
    expect(await readFile(join(home, "home-abs.txt"), "utf8")).toBe("from-home-abs");
    expect(await readFile(join(home, "home-rel.txt"), "utf8")).toBe("from-home-rel");
    await expect(readFile(join(rootfs, "root", "home-abs.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(rootfs, "home-rel.txt"), "utf8")).rejects.toThrow();
  });

  it("realpath returns absolute style paths when rootfs mode is active", async () => {
    expect(await fs.realpath("/tmp/from-root.txt")).toBe("/tmp/from-root.txt");
  });

  it("realpath preserves /root absolute style for home files", async () => {
    expect(await fs.realpath("/root/home-abs.txt")).toBe("/root/home-abs.txt");
  });

  it("safe mode still blocks symlink escape outside rootfs", async () => {
    await writeFile(join(tempDir, "root-secret.txt"), "s3cr3t");
    await symlink(join(tempDir, "root-secret.txt"), join(rootfs, "danger-link"));
    await expect(fs.readFile("/danger-link", "utf8")).rejects.toThrow(
      "outside of sandbox",
    );
  });

  it("routes /scratch paths to scratch mount when configured", async () => {
    scratch = join(tempDir, "test-scratch-mounted");
    await mkdir(scratch, { recursive: true });
    const fsScratch = new SandboxedFilesystem(home, { rootfs, scratch });
    await fsScratch.writeFile("/scratch/from-scratch.txt", "from-scratch");
    expect(await fsScratch.readFile("/scratch/from-scratch.txt", "utf8")).toBe(
      "from-scratch",
    );
    expect(await readFile(join(scratch, "from-scratch.txt"), "utf8")).toBe(
      "from-scratch",
    );
    await expect(
      readFile(join(rootfs, "scratch", "from-scratch.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("errors on /scratch when scratch mount is missing", async () => {
    const fsMissingScratch = new SandboxedFilesystem(home, {
      rootfs,
      scratch: join(tempDir, "scratch-missing"),
    });
    await expect(
      fsMissingScratch.writeFile("/scratch/blocked.txt", "blocked"),
    ).rejects.toThrow(
      "scratch is not mounted; cannot access absolute path '/scratch/blocked.txt'. Start the workspace and try again.",
    );
    await fsMissingScratch.writeFile("/tmp/rootfs-ok.txt", "rootfs-ok");
    expect(await fsMissingScratch.readFile("/tmp/rootfs-ok.txt", "utf8")).toBe(
      "rootfs-ok",
    );
    await fsMissingScratch.writeFile("/root/home-still-ok.txt", "home-ok");
    expect(await fsMissingScratch.readFile("/root/home-still-ok.txt", "utf8")).toBe(
      "home-ok",
    );
  });

});

afterAll(async () => {
  await rm(tempDir, { force: true, recursive: true });
});
