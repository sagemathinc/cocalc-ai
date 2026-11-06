import path from "node:path";
import os from "node:os";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";

let projectRoot: string;
let mockCallHub: jest.Mock;
let mockRustic: jest.Mock;
let mockStatusUpdates: any[];
let mockExact: boolean;
let mockAgentDest: jest.Mock;
let mockResolveAnchored: jest.Mock;

jest.mock("@cocalc/backend/logger", () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return {
    __esModule: true,
    default: jest.fn(() => logger),
    getLogger: jest.fn(() => logger),
  };
});

jest.mock("@cocalc/backend/sandbox", () => ({
  SandboxedFilesystem: class {
    private readonly root: string;

    constructor(root: string) {
      this.root = root;
    }

    async safeAbsPath(p: string): Promise<string> {
      return path.join(this.root, p.replace(/^\/+/, ""));
    }

    rootfsAgentDestination(p: string) {
      return mockAgentDest(p);
    }

    async resolveAnchoredPath(p: string) {
      mockResolveAnchored(p);
      return { root: this.root, path: p.replace(/^\/+/, "") };
    }

    async rustic(args: string[], opts?: { timeout?: number }) {
      return (
        (await mockRustic(args, this.root, opts)) ?? {
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          code: 0,
        }
      );
    }
  },
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCallHub(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: jest.fn(() => ({})),
}));

jest.mock("./sqlite/hosts", () => ({
  getLocalHostId: jest.fn(() => "host-1"),
}));

jest.mock("./file-server", () => ({
  ensureVolume: jest.fn(async () => undefined),
  getVolume: jest.fn(async () => ({ path: projectRoot })),
  getScratchMountpoint: jest.fn(() => path.join(projectRoot, ".tmp")),
  resolveRusticRepo: jest.fn(async () => "repo-profile"),
}));

jest.mock("@cocalc/project-runner/run/rootfs", () => ({
  getRootfsMountpoint: jest.fn(() => "/rootfs"),
}));

jest.mock("./last-edited", () => ({
  touchProjectLastEdited: jest.fn(),
}));

describe("project-host pending copies", () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(os.tmpdir(), "cocalc-copy-test-"));
    mockStatusUpdates = [];
    mockExact = true;
    mockAgentDest = jest.fn(() => undefined);
    mockResolveAnchored = jest.fn();
    mockCallHub = jest.fn(async ({ name, args }) => {
      if (name === "hosts.claimPendingCopies") {
        return [
          {
            copy_id: "copy-1",
            src_project_id: "src-project",
            src_path: "test.ipynb",
            dest_project_id: "dest-project",
            dest_path: "foo",
            snapshot_id: "snap-1",
            options: { force: true },
            exact: mockExact,
          },
        ];
      }
      if (name === "hosts.updateCopyStatus") {
        mockStatusUpdates.push(args[0]);
        return;
      }
      throw new Error(`unexpected callHub name ${name}`);
    });
    mockRustic = jest.fn(async (args: string[], root: string) => {
      const dest = path.join(root, args[2].replace(/^\/+/, ""));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, "notebook payload");
    });
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("replaces the exact destination instead of nesting a recollection", async () => {
    await mkdir(path.join(projectRoot, "foo"));

    const { applyPendingCopies } = await import("./pending-copies");
    await expect(applyPendingCopies({ limit: 1 })).resolves.toBe(1);

    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "done",
      }),
    ]);
    expect((await stat(path.join(projectRoot, "foo"))).isFile()).toBe(true);
    await expect(readFile(path.join(projectRoot, "foo"), "utf8")).resolves.toBe(
      "notebook payload",
    );
    // Nothing staged inside the project, and nothing left behind.
    expect(await readdir(projectRoot)).toEqual(["foo"]);
  });

  it("restores outside the destination project, where its user cannot reach", async () => {
    const { applyPendingCopies } = await import("./pending-copies");
    await applyPendingCopies({ limit: 1 });

    const [args, restoreRoot] = mockRustic.mock.calls[0];
    expect(args[0]).toBe("restore");
    expect(path.relative(projectRoot, restoreRoot).startsWith("..")).toBe(true);
    // The staging directory is removed afterwards.
    await expect(stat(restoreRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a destination through a symlink the destination project planted", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "cocalc-outside-"));
    try {
      await symlink(outside, path.join(projectRoot, "evil"));
      mockCallHub = jest.fn(async ({ name, args }) => {
        if (name === "hosts.claimPendingCopies") {
          return [
            {
              copy_id: "copy-1",
              src_project_id: "src-project",
              src_path: "test.ipynb",
              dest_project_id: "dest-project",
              dest_path: "evil/authorized_keys",
              snapshot_id: "snap-1",
              options: { force: true },
              exact: mockExact,
            },
          ];
        }
        if (name === "hosts.updateCopyStatus") {
          mockStatusUpdates.push(args[0]);
          return;
        }
        throw new Error(`unexpected callHub name ${name}`);
      });

      const { applyPendingCopies } = await import("./pending-copies");
      for (const exact of [true, false]) {
        mockExact = exact;
        mockStatusUpdates = [];
        await applyPendingCopies({ limit: 1 });
        expect(mockStatusUpdates).toEqual([
          expect.objectContaining({
            status: "failed",
            last_error: expect.stringContaining("ELOOP"),
          }),
        ]);
      }
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("retries a transient missing snapshot during restore", async () => {
    mockRustic
      .mockRejectedValueOnce(new Error("no snapshot with id snap-1"))
      .mockImplementationOnce(async (args: string[], root: string) => {
        const dest = path.join(root, args[2].replace(/^\/+/, ""));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, "notebook payload");
      });

    const { applyPendingCopies } = await import("./pending-copies");
    await expect(applyPendingCopies({ limit: 1 })).resolves.toBe(1);

    expect(mockRustic).toHaveBeenCalledTimes(2);
    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "done",
      }),
    ]);
    await expect(readFile(path.join(projectRoot, "foo"), "utf8")).resolves.toBe(
      "notebook payload",
    );
  });

  it("bounds the restore and copy by the claim's budget", async () => {
    const { applyPendingCopies } = await import("./pending-copies");
    await applyPendingCopies({ limit: 1 });

    const budget = 30 * 60 * 1000;
    const restoreTimeout = mockRustic.mock.calls[0][2]?.timeout;
    expect(restoreTimeout).toBeGreaterThan(0);
    expect(restoreTimeout).toBeLessThanOrEqual(budget);
  });

  it("leaves later rows for the hub to reclaim once the claim's budget is spent", async () => {
    const row = (copy_id: string, dest_path: string) => ({
      copy_id,
      src_project_id: "src-project",
      src_path: "test.ipynb",
      dest_project_id: "dest-project",
      dest_path,
      snapshot_id: "snap-1",
      options: { force: true },
      exact: true,
    });
    const claim = mockCallHub.getMockImplementation()!;
    mockCallHub.mockImplementation(async (opts) =>
      opts.name === "hosts.claimPendingCopies"
        ? [row("copy-1", "foo"), row("copy-2", "bar")]
        : claim(opts),
    );
    const realNow = Date.now();
    let offset = 0;
    const nowSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() => realNow + offset);
    try {
      mockRustic.mockImplementationOnce(
        async (args: string[], root: string) => {
          const dest = path.join(root, args[2].replace(/^\/+/, ""));
          await mkdir(path.dirname(dest), { recursive: true });
          await writeFile(dest, "notebook payload");
          offset = 31 * 60 * 1000;
        },
      );
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 2 });
    } finally {
      nowSpy.mockRestore();
    }

    // The first row stops before copying; the second is never started and
    // stays 'applying' until the hub hands it out again.
    expect(mockRustic).toHaveBeenCalledTimes(1);
    expect(await readdir(projectRoot)).toEqual([]);
    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "failed",
        last_error: expect.stringContaining("claim expired"),
      }),
    ]);
  });

  it("fails the copy when the restore is killed part way", async () => {
    mockRustic.mockImplementationOnce(async (args: string[], root: string) => {
      const dest = path.join(root, args[2].replace(/^\/+/, ""));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, "partial");
      return { stdout: Buffer.from(""), stderr: Buffer.from(""), code: 143 };
    });

    const { applyPendingCopies } = await import("./pending-copies");
    await applyPendingCopies({ limit: 1 });

    expect(await readdir(projectRoot)).toEqual([]);
    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "failed",
        last_error: expect.stringContaining("exited with code 143"),
      }),
    ]);
  });

  it("skips an exact no-clobber copy before restoring its snapshot", async () => {
    mockCallHub = jest.fn(async ({ name, args }) => {
      if (name === "hosts.claimPendingCopies") {
        return [
          {
            copy_id: "copy-1",
            src_project_id: "src-project",
            src_path: "test.ipynb",
            dest_project_id: "dest-project",
            dest_path: "foo",
            snapshot_id: "expired-snapshot",
            options: { force: false },
            exact: true,
          },
        ];
      }
      if (name === "hosts.updateCopyStatus") {
        mockStatusUpdates.push(args[0]);
        return;
      }
      throw new Error(`unexpected callHub name ${name}`);
    });
    mockRustic.mockRejectedValue(new Error("snapshot not found"));
    await writeFile(path.join(projectRoot, "foo"), "existing payload");

    const { applyPendingCopies } = await import("./pending-copies");
    await expect(applyPendingCopies({ limit: 1 })).resolves.toBe(1);

    expect(mockRustic).not.toHaveBeenCalled();
    await expect(readFile(path.join(projectRoot, "foo"), "utf8")).resolves.toBe(
      "existing payload",
    );
    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "done",
      }),
    ]);
  });

  it("merges an ordinary directory copy at its resolved destination", async () => {
    mockExact = false;
    mockCallHub = jest.fn(async ({ name, args }) => {
      if (name === "hosts.claimPendingCopies") {
        return [
          {
            copy_id: "copy-1",
            src_project_id: "src-project",
            src_path: "handouts/lecture notes",
            dest_project_id: "dest-project",
            dest_path: "handouts/lecture notes",
            snapshot_id: "snap-1",
            options: { force: false, recursive: true },
            exact: false,
          },
        ];
      }
      if (name === "hosts.updateCopyStatus") {
        mockStatusUpdates.push(args[0]);
        return;
      }
      throw new Error(`unexpected callHub name ${name}`);
    });
    mockRustic = jest.fn(async (args: string[], root: string) => {
      const dest = path.join(root, args[2].replace(/^\/+/, ""));
      await mkdir(dest, { recursive: true });
      await writeFile(path.join(dest, "new.txt"), "new");
    });
    const destination = path.join(projectRoot, "handouts", "lecture notes");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "keep.txt"), "keep");

    const { applyPendingCopies } = await import("./pending-copies");
    await expect(applyPendingCopies({ limit: 1 })).resolves.toBe(1);

    await expect(
      readFile(path.join(destination, "new.txt"), "utf8"),
    ).resolves.toBe("new");
    await expect(
      readFile(path.join(destination, "keep.txt"), "utf8"),
    ).resolves.toBe("keep");
    await expect(
      readFile(path.join(destination, "lecture notes", "new.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  describe("into a separate-uid project's rootfs (through its agent)", () => {
    // stands for the container: container paths map into this dir
    let container: string;
    const fsAgent = () => {
      const at = (p: string) => path.join(container, p);
      const coded = (code: string) => Object.assign(new Error(code), { code });
      const calls: string[] = [];
      const call = async (op: string, a: any, data?: Buffer) => {
        calls.push(`${op} ${a.path}`);
        const {
          lstat: lst,
          mkdir: mk,
          writeFile: wf,
          chmod: ch,
          rename: rn,
          rm: rmx,
          symlink: sl,
          unlink: ul,
          utimes: ut,
        } = await import("node:fs/promises");
        try {
          switch (op) {
            case "lstat": {
              const st = await lst(at(a.path));
              return {
                result: {
                  type: st.isDirectory()
                    ? "dir"
                    : st.isSymbolicLink()
                      ? "symlink"
                      : "file",
                },
              };
            }
            case "mkdir":
              await mk(at(a.path), { recursive: !!a.recursive, mode: a.mode });
              return { result: null };
            case "writeFile":
              await wf(at(a.path), data!, {
                mode: a.mode,
                flag: a.noReplace ? "wx" : "w",
              });
              return { result: null };
            case "chmod":
              await ch(at(a.path), a.mode);
              return { result: null };
            case "rename":
              await rn(at(a.path), at(a.dest));
              return { result: null };
            case "rm":
              await rmx(at(a.path), {
                recursive: !!a.recursive,
                force: !!a.force,
              });
              return { result: null };
            case "symlink":
              await sl(a.target, at(a.path));
              return { result: null };
            case "unlink":
              await ul(at(a.path));
              return { result: null };
            case "utimes":
              await ut(at(a.path), a.atime, a.mtime);
              return { result: null };
          }
        } catch (err: any) {
          throw coded(err.code ?? "EIO");
        }
        throw coded("ENOSYS");
      };
      return { agent: { call }, calls };
    };

    let readiness: string;
    beforeEach(async () => {
      container = await mkdtemp(
        path.join(os.tmpdir(), "cocalc-copy-container-"),
      );
      await mkdir(path.join(container, "etc"));
      readiness = "agent";
      const { copyDeps } = await import("./pending-copies");
      copyDeps.rootfsCopyReadiness = (async () => readiness) as any;
    });
    afterEach(async () => {
      await rm(container, { recursive: true, force: true });
    });

    const rootfsRow = (copy_id: string, exact = false) => {
      mockCallHub = jest.fn(async ({ name, args }) => {
        if (name === "hosts.claimPendingCopies") {
          return [
            {
              copy_id,
              src_project_id: "src-project",
              src_path: "test.ipynb",
              dest_project_id: "dest-project",
              dest_path: "/etc/foo",
              snapshot_id: "snap-1",
              options: { force: true },
              exact,
            },
          ];
        }
        if (name === "hosts.updateCopyStatus")
          return void mockStatusUpdates.push(args[0]);
        throw new Error(`unexpected ${name}`);
      });
    };

    it("defers a rootfs copy while the project's rootfs isn't live: queued, nothing restored or written (B5)", async () => {
      readiness = "defer";
      mockAgentDest = jest.fn(() => undefined);
      rootfsRow("copy-d");
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates).toEqual([
        expect.objectContaining({ copy_id: "copy-d", status: "queued" }),
      ]);
      expect(mockRustic).not.toHaveBeenCalled();
      expect(mockResolveAnchored).not.toHaveBeenCalled();
      expect(await readdir(projectRoot)).toEqual([]);
      expect(await readdir(path.join(container, "etc"))).toEqual([]);
    });

    it("runs a deferred rootfs copy once the project runs: queued before the start, done after it (B5)", async () => {
      const { agent } = fsAgent();
      mockAgentDest = jest.fn((p: string) =>
        readiness === "agent" ? { agent, containerPath: p } : undefined,
      );
      const { applyPendingCopies } = await import("./pending-copies");
      readiness = "defer";
      rootfsRow("copy-l");
      await applyPendingCopies({ limit: 1 });
      readiness = "agent";
      rootfsRow("copy-l");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates.map((u) => u.status)).toEqual([
        "queued",
        "done",
      ]);
      expect(await readFile(path.join(container, "etc", "foo"), "utf8")).toBe(
        "notebook payload",
      );
      expect(mockResolveAnchored).not.toHaveBeenCalled();
      expect(await readdir(projectRoot)).toEqual([]);
    });

    it("defers, not fails, when the agent should be there but isn't, or goes away (B5)", async () => {
      const { applyPendingCopies } = await import("./pending-copies");
      mockAgentDest = jest.fn(() => undefined);
      rootfsRow("copy-n");
      await applyPendingCopies({ limit: 1 });
      const gone = {
        call: async () => {
          throw Object.assign(new Error("the rootfs agent went away"), {
            name: "AgentUnavailableError",
            retryable: true,
          });
        },
      };
      mockAgentDest = jest.fn(() => ({
        agent: gone,
        containerPath: "/etc/foo",
      }));
      rootfsRow("copy-g");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates.map((u) => [u.copy_id, u.status])).toEqual([
        ["copy-n", "queued"],
        ["copy-g", "queued"],
      ]);
      expect(mockResolveAnchored).not.toHaveBeenCalled();
    });

    it("keeps HOME copies as before, whatever the rootfs readiness (B5)", async () => {
      readiness = "defer";
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates).toEqual([
        expect.objectContaining({ copy_id: "copy-1", status: "done" }),
      ]);
      expect(await readFile(path.join(projectRoot, "foo"), "utf8")).toBe(
        "notebook payload",
      );
    });

    it("installs through the agent, never on the host, and removes the staging", async () => {
      const { agent } = fsAgent();
      mockAgentDest = jest.fn((p: string) =>
        p === "/etc/foo" ? { agent, containerPath: "/etc/foo" } : undefined,
      );
      mockCallHub = jest.fn(async ({ name, args }) => {
        if (name === "hosts.claimPendingCopies") {
          return [
            {
              copy_id: "copy-r",
              src_project_id: "src-project",
              src_path: "test.ipynb",
              dest_project_id: "dest-project",
              dest_path: "/etc/foo",
              snapshot_id: "snap-1",
              options: { force: true },
              exact: true,
            },
          ];
        }
        if (name === "hosts.updateCopyStatus")
          return void mockStatusUpdates.push(args[0]);
        throw new Error(`unexpected ${name}`);
      });
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates).toEqual([
        expect.objectContaining({ copy_id: "copy-r", status: "done" }),
      ]);
      expect(await readFile(path.join(container, "etc", "foo"), "utf8")).toBe(
        "notebook payload",
      );
      // nothing resolved or written on the host's side of the project
      expect(mockResolveAnchored).not.toHaveBeenCalled();
      expect(await readdir(projectRoot)).toEqual([]);
      const [, restoreRoot] = mockRustic.mock.calls[0];
      await expect(stat(restoreRoot)).rejects.toMatchObject({ code: "ENOENT" });
      // no hidden siblings left in the container
      expect(await readdir(path.join(container, "etc"))).toEqual(["foo"]);
    });

    it("S2: a lying agent closes only this copy's own row, and the host's staging still goes", async () => {
      const lies: string[] = [];
      const agent = {
        call: async (op: string) => {
          lies.push(op);
          if (op === "lstat")
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          return { result: null };
        },
      };
      mockAgentDest = jest.fn(() => ({ agent, containerPath: "/etc/foo" }));
      mockCallHub = jest.fn(async ({ name, args }) => {
        if (name === "hosts.claimPendingCopies") {
          return [
            {
              copy_id: "copy-lie",
              src_project_id: "src-project",
              src_path: "test.ipynb",
              dest_project_id: "dest-project",
              dest_path: "/etc/foo",
              snapshot_id: "snap-1",
              options: { force: true },
              exact: false,
            },
          ];
        }
        if (name === "hosts.updateCopyStatus")
          return void mockStatusUpdates.push(args[0]);
        throw new Error(`unexpected ${name}`);
      });
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 1 });
      // the only effects: this row's status, and the host's own cleanup
      expect(mockStatusUpdates).toEqual([
        expect.objectContaining({ copy_id: "copy-lie", status: "done" }),
      ]);
      expect(mockCallHub.mock.calls.map(([c]) => c.name)).toEqual([
        "hosts.claimPendingCopies",
        "hosts.updateCopyStatus",
      ]);
      const [, restoreRoot] = mockRustic.mock.calls[0];
      await expect(stat(restoreRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readdir(projectRoot)).toEqual([]);
      expect(lies.length).toBeGreaterThan(0);
    });

    it("an agent error fails only this row, and the staging still goes", async () => {
      const agent = {
        call: async () => {
          throw Object.assign(
            new Error("the project isn't running with a separate runtime uid"),
            { code: "EUNAVAIL" },
          );
        },
      };
      mockAgentDest = jest.fn(() => ({ agent, containerPath: "/etc/foo" }));
      mockCallHub = jest.fn(async ({ name, args }) => {
        if (name === "hosts.claimPendingCopies") {
          return [
            {
              copy_id: "copy-e",
              src_project_id: "src-project",
              src_path: "test.ipynb",
              dest_project_id: "dest-project",
              dest_path: "/etc/foo",
              snapshot_id: "snap-1",
              options: { force: true },
              exact: false,
            },
          ];
        }
        if (name === "hosts.updateCopyStatus")
          return void mockStatusUpdates.push(args[0]);
        throw new Error(`unexpected ${name}`);
      });
      const { applyPendingCopies } = await import("./pending-copies");
      await applyPendingCopies({ limit: 1 });
      expect(mockStatusUpdates).toEqual([
        expect.objectContaining({ copy_id: "copy-e", status: "failed" }),
      ]);
      const [, restoreRoot] = mockRustic.mock.calls[0];
      await expect(stat(restoreRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
