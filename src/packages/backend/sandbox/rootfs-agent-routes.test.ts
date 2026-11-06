import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxedFilesystem } from "./index";
import {
  containerPath,
  rootfsContainerPath,
  type RootfsAgentOps,
} from "./rootfs-agent-routes";

const classifier = {
  homeAliases: ["/home/user"],
  hasScratch: true,
  hasSharedScratch: false,
  containerHome: "/home/user",
};

describe("rootfs path classification (lexical)", () => {
  it.each([
    ["/etc/os-release", "/etc/os-release"],
    ["/usr/../etc/passwd", "/etc/passwd"],
    ["/home/user/../../etc/x", "/etc/x"],
    ["/home/userx", "/home/userx"],
    ["/", "/"],
    ["/tmpx", "/tmpx"],
  ])("%s is a rootfs path (%s in the container)", (path, inContainer) => {
    expect(rootfsContainerPath(path, classifier)).toBe(inContainer);
  });

  it.each([
    "a.txt",
    "dir/x",
    "/home/user",
    "/home/user/a",
    "/tmp/x",
    "/scratch/x",
  ])("%s is not", (path) => {
    expect(rootfsContainerPath(path, classifier)).toBeUndefined();
  });

  it("treats /tmp as rootfs when the project has no scratch", () => {
    expect(
      rootfsContainerPath("/tmp/x", { ...classifier, hasScratch: false }),
    ).toBe("/tmp/x");
  });

  it("translates any project path to the container's view", () => {
    expect(containerPath("a/b", classifier)).toBe("/home/user/a/b");
    expect(containerPath("/home/user/a", classifier)).toBe("/home/user/a");
    expect(containerPath("/etc/x", classifier)).toBe("/etc/x");
  });
});

describe("SandboxedFilesystem with a rootfs agent", () => {
  let home: string;
  let calls: { op: string; args: any; data?: Buffer }[];
  let agent: RootfsAgentOps;
  const STAT = {
    type: "file",
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: 5,
    nlink: 1,
    ino: 9,
    mtimeMs: 1000,
    atimeMs: 1000,
    ctimeMs: 1000,
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "sandbox-agent-"));
    calls = [];
    agent = {
      call: async (op, args, data) => {
        calls.push({ op, args, data });
        if (op === "stat" || op === "lstat") {
          if (args.path === "/nope") {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return { result: STAT };
        }
        if (op === "readFile") {
          return { result: { size: 5 }, data: Buffer.from("hello") };
        }
        if (op === "readdir") {
          return {
            result: {
              entries: [
                { name: "a", type: "file" },
                { name: "d", type: "dir" },
              ],
              truncated: false,
            },
          };
        }
        if (op === "realpath" || op === "readlink")
          return { result: "/etc/real" };
        return { result: null };
      },
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // The rootfs dir doesn't exist: any host access would fail differently.
  const fs = (over: object = {}) =>
    new SandboxedFilesystem(home, {
      rootfs: join(home, "..", "no-such-rootfs"),
      homeAliases: ["/home/user"],
      rootfsAgent: agent,
      ...over,
    });

  it("names the agent and the container path for a rootfs install destination, nothing else", async () => {
    const sfs = fs();
    const d = sfs.rootfsAgentDestination("/etc/./foo/../bar");
    expect(d?.containerPath).toBe("/etc/bar");
    expect(d?.agent).toBe(agent);
    // HOME (relative or by alias) and /tmp are not the rootfs
    expect(sfs.rootfsAgentDestination("foo")).toBeUndefined();
    expect(sfs.rootfsAgentDestination("/home/user/foo")).toBeUndefined();
    // no agent (keep-id, or the project not running separate): undefined
    expect(
      fs({ rootfsAgent: () => undefined }).rootfsAgentDestination("/etc/x"),
    ).toBeUndefined();
    // a read-only sandbox refuses before anything is sent
    expect(() =>
      fs({ readonly: true }).rootfsAgentDestination("/etc/x"),
    ).toThrow();
    expect(calls).toEqual([]);
  });

  it("sends rootfs operations to the agent, with container paths", async () => {
    const sfs = fs();
    const st: any = await sfs.stat("/etc/os-release");
    expect(st.size).toBe(5);
    expect(st.isFile()).toBe(true);
    expect(st.mtime).toEqual(new Date(1000));
    expect(await sfs.exists("/etc/os-release")).toBe(true);
    expect(await sfs.exists("/nope")).toBe(false);
    expect(await sfs.readFile("/etc/os-release", "utf8")).toBe("hello");
    expect(await sfs.readdir("/etc")).toEqual(["a", "d"]);
    const dirents: any[] = (await sfs.readdir("/etc", {
      withFileTypes: true,
    })) as any;
    expect(dirents.map((d) => [d.name, d.isDirectory()])).toEqual([
      ["a", false],
      ["d", true],
    ]);
    await sfs.writeFile("/etc/motd", "hi");
    await sfs.mkdir("/opt/x", { recursive: true, mode: "755" });
    await sfs.chmod("/etc/motd", "600");
    await sfs.rm(["/opt/x", "/opt/y"], { recursive: true, force: true });
    expect(calls.map((c) => [c.op, c.args.path])).toEqual([
      ["stat", "/etc/os-release"],
      ["stat", "/etc/os-release"],
      ["stat", "/nope"],
      ["readFile", "/etc/os-release"],
      ["readdir", "/etc"],
      ["readdir", "/etc"],
      ["writeFile", "/etc/motd"],
      ["mkdir", "/opt/x"],
      ["chmod", "/etc/motd"],
      ["rm", "/opt/x"],
      ["rm", "/opt/y"],
    ]);
    expect(calls[6].data!.toString()).toBe("hi");
    expect(calls[7].args).toMatchObject({ recursive: true, mode: 0o755 });
    expect(calls[8].args.mode).toBe(0o600);
  });

  it("runs an operation between HOME and the rootfs in the agent, translating HOME", async () => {
    await fs().rename("notes.txt", "/etc/notes.txt");
    expect(calls).toEqual([
      {
        op: "rename",
        args: { path: "/home/user/notes.txt", dest: "/etc/notes.txt" },
        data: undefined,
      },
    ]);
  });

  it("fails other operations on rootfs paths explicitly, without the agent or the disk", async () => {
    const sfs = fs();
    for (const attempt of [
      () => sfs.symlink("x", "/etc/link"),
      () => sfs.copyFile("a", "/etc/b"),
      () => sfs.truncate("/etc/x", 0),
      () => sfs.appendFile("/etc/x", "y"),
      () => sfs.createReadStream("/etc/x"),
      () => sfs.find("/etc"),
      () => sfs.utimes("/etc/x", 1, 1).then(() => sfs.link("/etc/x", "/etc/y")),
    ]) {
      await expect(attempt()).rejects.toThrow(
        "are not available yet for projects that run with a separate runtime uid",
      );
    }
    expect(calls.map((c) => c.op)).toEqual(["utimes"]);
  });

  it("fails a pending copy's install into the rootfs, and fd/ripgrep/du there, explicitly and without the disk (phase 1)", async () => {
    const sfs = fs();
    for (const attempt of [
      // pending copies resolve their destination this way first
      () => sfs.resolveAnchoredPath("/opt/data/file.txt"),
      () => sfs.fd("/etc"),
      () => sfs.ripgrep("/etc", "x"),
      () => sfs.du("/usr"),
      () => sfs.dust("/usr"),
    ]) {
      await expect(attempt()).rejects.toThrow(
        "are not available yet for projects that run with a separate runtime uid",
      );
    }
    expect(calls).toEqual([]);
    // nothing was created on the host for it either
    await expect(
      readFile(join(home, "..", "no-such-rootfs", "opt", "data", "file.txt")),
    ).rejects.toThrow();
  });

  it("never starts the agent for a cross-project cp: its path checks refuse first (S1)", async () => {
    // project-host's cp() resolves both sides with these before copying;
    // the hub has authorized the caller for both projects before that.
    const src = fs();
    const dest = fs();
    await expect(src.safeAbsPaths(["/etc/a", "b.txt"])).rejects.toThrow(
      "are not available yet",
    );
    await expect(dest.safeAbsPath("/opt/b")).rejects.toThrow(
      "are not available yet",
    );
    await expect(dest.resolveAnchoredPath("/opt/b")).rejects.toThrow(
      "are not available yet",
    );
    expect(calls).toEqual([]);
    // HOME on both sides still works, without the agent
    expect(await src.safeAbsPaths(["b.txt"])).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("keeps a read-only sandbox read-only", async () => {
    const sfs = fs({ readonly: true });
    await expect(sfs.writeFile("/etc/x", "y")).rejects.toThrow("read only");
    await expect(sfs.rm("/etc/x")).rejects.toThrow("read only");
    expect(calls).toEqual([]);
    expect((await sfs.stat("/etc/x")).size).toBe(5);
  });

  it("never sends HOME or /tmp operations to the agent", async () => {
    const sfs = fs();
    await sfs.writeFile("a.txt", "local");
    await sfs.writeFile("/home/user/b.txt", "local");
    expect(await readFile(join(home, "a.txt"), "utf8")).toBe("local");
    expect(await readFile(join(home, "b.txt"), "utf8")).toBe("local");
    expect((await sfs.stat("a.txt")).size).toBe(5);
    expect(calls).toEqual([]);
  });
});
