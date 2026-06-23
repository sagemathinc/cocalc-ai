import path from "node:path";
import os from "node:os";
import {
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
let mockStatusUpdates: any[];

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
      const dest = await this.safeAbsPath(args[2]);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, "notebook payload");
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
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("copies into an existing destination directory instead of replacing it", async () => {
    await mkdir(path.join(projectRoot, "foo"));

    const { applyPendingCopies } = await import("./pending-copies");
    await expect(applyPendingCopies({ limit: 1 })).resolves.toBe(1);

    expect(mockStatusUpdates).toEqual([
      expect.objectContaining({
        copy_id: "copy-1",
        status: "done",
      }),
    ]);
    expect((await stat(path.join(projectRoot, "foo"))).isDirectory()).toBe(
      true,
    );
    await expect(
      readFile(path.join(projectRoot, "foo", "test.ipynb"), "utf8"),
    ).resolves.toBe("notebook payload");
    const [stagingPath, destPath, copyOptions] = mockCpExec.mock.calls[0];
    expect(stagingPath).toContain(path.join(".copy-staging"));
    expect(stagingPath.endsWith(path.join("foo", "test.ipynb"))).toBe(true);
    expect(destPath).toBe(path.join(projectRoot, "foo", "test.ipynb"));
    expect(copyOptions).toEqual(
      expect.objectContaining({
        recursive: true,
        reflink: true,
      }),
    );
  });
});
