import path from "node:path";
import os from "node:os";
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";

let projectRoot: string;
let mockCallHub: jest.Mock;
let mockCpExec: jest.Mock;
let mockRustic: jest.Mock;
let mockStatusUpdates: any[];
let mockExact: boolean;

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

    async rustic(args: string[]): Promise<void> {
      return await mockRustic(args, this.root);
    }
  },
}));

jest.mock("@cocalc/backend/sandbox/cp", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCpExec(...args),
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
    mockCpExec = jest.fn(async (src: string, dest: string) => {
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
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
    const [stagingPath, destPath, copyOptions] = mockCpExec.mock.calls[0];
    expect(stagingPath).toContain(path.join(".copy-staging"));
    expect(stagingPath.endsWith("foo")).toBe(true);
    expect(destPath).toContain(path.join(projectRoot, ".foo.cocalc-incoming-"));
    expect(copyOptions).toEqual(
      expect.objectContaining({
        recursive: true,
        reflink: true,
      }),
    );
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
    expect(mockCpExec).not.toHaveBeenCalled();
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
    mockCpExec = jest.fn(async (src: string, dest: string) => {
      await cp(src, dest, { force: false, recursive: true });
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
    expect(mockCpExec.mock.calls[0][1]).toBe(destination);
  });
});
