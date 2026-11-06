import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { data } from "@cocalc/backend/data";
import {
  cleanupHandoff,
  createHandoffDir,
  defaultHandoffRoot,
  handoffParent,
  handOver,
  readBack,
  type Unshare,
} from "./sidecar-handoff";

// Without podman here: run the same argv directly, and record it.
function localUnshare(log: string[][]): Unshare {
  return async (argv) => {
    log.push(argv);
    if (argv[0] === "chown") return { stdout: "" };
    return await new Promise((resolve, reject) =>
      execFile(argv[0], argv.slice(1), (err, stdout) =>
        err ? reject(err) : resolve({ stdout: `${stdout}` }),
      ),
    );
  };
}

describe("sidecar handoff", () => {
  let root: string;
  let log: string[][];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "handoff-"));
    log = [];
  });

  afterEach(async () => {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it("keeps handed-over directories under a 0700 parent of the daemon's own (H1)", async () => {
    const parent = join(root, "parent");
    await mkdir(parent, { mode: 0o755 });
    // an existing parent with a looser mode is tightened
    await handoffParent(parent);
    expect((await stat(parent)).mode & 0o777).toBe(0o700);
    // a symlink in its place is refused, and its target's mode untouched
    const target = join(root, "target");
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    const link = join(root, "link");
    await symlink(target, link);
    await expect(handoffParent(link)).rejects.toThrow("not a directory");
    expect((await stat(target)).mode & 0o777).toBe(0o755);
  });

  it("puts the handoff parent in the daemon's own state, not a shared tmp (H1)", () => {
    expect(defaultHandoffRoot()).toBe(join(data, "sidecar-handoff"));
    expect(defaultHandoffRoot().startsWith(tmpdir())).toBe(false);
  });

  it("refuses a handoff parent that isn't the daemon's own (H1)", async () => {
    const parent = join(root, "theirs");
    await mkdir(parent, { mode: 0o755 });
    await chmod(parent, 0o755);
    const real = process.getuid!;
    const spy = jest
      .spyOn(process, "getuid")
      .mockImplementation(() => real.call(process) + 1);
    try {
      await expect(handoffParent(parent)).rejects.toThrow(
        "not the daemon's own",
      );
    } finally {
      spy.mockRestore();
    }
    // checked before chmod: its mode is untouched
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
  });

  it("chowns exactly the recorded paths, one at a time, never recursively or through a symlink (H2)", async () => {
    const parent = await handoffParent(join(root, "p"));
    const h = await createHandoffDir(parent, "acp-relay");
    h.entries.push(join(h.dir, "socket"));
    // the uid and gid maps may give different inner ids
    await handOver(h, { uid: 4194305, gid: 4194399 }, localUnshare(log));
    expect(log).toEqual([
      [
        "chown",
        "--no-dereference",
        "4194305:4194399",
        "--",
        join(h.dir, "socket"),
      ],
      ["chown", "--no-dereference", "4194305:4194399", "--", h.dir],
    ]);
    for (const argv of log) {
      expect(argv).not.toContain("-R");
      expect(argv).not.toContain("--recursive");
      expect(argv).not.toContain("--dereference");
    }
    for (const inner of [
      { uid: 0, gid: 5 },
      { uid: 5, gid: 0 },
    ]) {
      await expect(handOver(h, inner, localUnshare(log))).rejects.toThrow(
        "bad inner id",
      );
    }
  });

  it("reads back a regular file within the cap, and nothing else", async () => {
    const parent = await handoffParent(join(root, "p"));
    const h = await createHandoffDir(parent, "codex");
    const outside = join(root, "outside-secret");
    await writeFile(outside, "host secret");
    await writeFile(join(h.dir, "auth.json"), '{"token":"t"}');
    const unshare = localUnshare(log);

    expect(
      (await readBack(h, "auth.json", 1024, unshare)).data!.toString(),
    ).toBe('{"token":"t"}');
    // a symlink planted in its place is not followed
    await rm(join(h.dir, "auth.json"));
    await symlink(outside, join(h.dir, "auth.json"));
    expect(await readBack(h, "auth.json", 1024, unshare)).toEqual({
      error: "ELOOP",
    });
    // a FIFO is refused without blocking
    await rm(join(h.dir, "auth.json"));
    await new Promise<void>((resolve, reject) =>
      execFile("mkfifo", [join(h.dir, "auth.json")], (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    expect(await readBack(h, "auth.json", 1024, unshare)).toEqual({
      error: "EFTYPE",
    });
    // an oversize file is refused without reading it
    await rm(join(h.dir, "auth.json"));
    await writeFile(join(h.dir, "auth.json"), "");
    await truncate(join(h.dir, "auth.json"), 10 * 1024 * 1024);
    expect(await readBack(h, "auth.json", 1024, unshare)).toEqual({
      error: "EFBIG",
    });
    // names that aren't one plain component are refused
    for (const name of ["../outside-secret", "a/b", "..", ""]) {
      expect((await readBack(h, name, 1024, unshare)).data).toBeUndefined();
    }
  });

  it("refuses a name that leaves the recorded directory, even where that file exists (V16)", async () => {
    const parent = await handoffParent(join(root, "p"));
    const h = await createHandoffDir(parent, "codex");
    // beside the handed-over directory: what "../sibling" would reach
    await writeFile(join(parent, "sibling"), "not yours");
    await mkdir(join(h.dir, "a"));
    await writeFile(join(h.dir, "a", "b"), "nested");
    for (const name of ["../sibling", ".", "..", "a/b", ""]) {
      expect(await readBack(h, name, 1024, localUnshare(log))).toEqual({
        error: "EINVAL",
      });
    }
  });

  it("refuses a handed-over directory swapped for a symlink", async () => {
    const parent = await handoffParent(join(root, "p"));
    const h = await createHandoffDir(parent, "codex");
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "auth.json"), "x");
    await rm(h.dir, { recursive: true });
    await symlink(elsewhere, h.dir);
    // O_DIRECTORY|O_NOFOLLOW on a symlink: ENOTDIR (or ELOOP); never read
    const res = await readBack(h, "auth.json", 1024, localUnshare(log));
    expect(res.data).toBeUndefined();
    expect(["ENOTDIR", "ELOOP"]).toContain(res.error);
  });

  it("treats a malformed reader answer as no answer", async () => {
    const parent = await handoffParent(join(root, "p"));
    const h = await createHandoffDir(parent, "codex");
    for (const stdout of ["not json", "null", '{"data":5}', "[]"]) {
      const res = await readBack(h, "x", 10, async () => ({ stdout }));
      expect(res.data).toBeUndefined();
    }
  });

  it("removes exactly the recorded directory, and proves it gone", async () => {
    const parent = await handoffParent(join(root, "p"));
    const keep = join(root, "keep");
    await mkdir(keep);
    await writeFile(join(keep, "precious"), "x");
    const h = await createHandoffDir(parent, "ctl");
    await symlink(keep, join(h.dir, "link"));
    await cleanupHandoff(h, localUnshare(log));
    await expect(lstat(h.dir)).rejects.toThrow();
    expect((await stat(join(keep, "precious"))).size).toBe(1);
    expect(log.at(-1)).toEqual(["rm", "-rf", "--one-file-system", "--", h.dir]);
    // a removal that leaves it there is an error
    const h2 = await createHandoffDir(parent, "ctl");
    await expect(
      cleanupHandoff(h2, async () => ({ stdout: "" })),
    ).rejects.toThrow("still there");
  });
});
