import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import {
  deleteRedundantSnapshotHome,
  preserveSnapshotHistory,
  replaceSnapshotHome,
} from "./snapshot-restore-history";

jest.mock("@cocalc/file-server/btrfs/util", () => ({
  btrfs: jest.fn(),
  sudo: jest.fn(),
}));
const runBtrfs = jest.mocked(btrfs);
const runSudo = jest.mocked(sudo);

describe("snapshot restore history", () => {
  let root: string;
  let home: string;
  let replacement: string;
  let retired: string;
  let copied: string[];
  const names = [
    "2026-09-27T00:00:00.000Z",
    "checkpoint-a",
    "checkpoint-b",
    "safety-before-restore",
  ];

  beforeEach(async () => {
    jest.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), "snapshot-restore-"));
    home = join(root, "home");
    replacement = join(root, "replacement");
    retired = join(root, "retired");
    copied = [];
    for (const dir of [home, replacement]) {
      await mkdir(join(dir, ".snapshots"), { recursive: true });
    }
    for (const name of names) {
      await mkdir(join(home, ".snapshots", name));
      await writeFile(join(home, ".snapshots", name, "data"), name);
    }
    await writeFile(join(home, ".snapshots", ".checkpoint-b.lock"), "");
    // A nonrecursive HOME clone has empty stubs and historical lock files.
    await mkdir(join(replacement, ".snapshots", "checkpoint-a"));
    await writeFile(join(replacement, ".snapshots", ".stale.lock"), "");
    await writeFile(join(home, "data"), "current");
    await writeFile(join(replacement, "data"), "restored");
    runSudo.mockImplementation(async ({ command, args = [] }) => {
      if (command === "rm") await rm(args[1], { recursive: true, force: true });
      else if (command === "mv") await rename(args[0], args[1]);
      else throw new Error(`unexpected command ${command}`);
      return { stdout: "", stderr: "", exit_code: 0 };
    });
    runBtrfs.mockImplementation(async ({ args = [] }) => {
      if (args[1] === "snapshot") {
        expect(args[2]).toBe("-r");
        await cp(args[3], args[4], {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      } else if (args[1] === "delete") {
        await rm(args[2], { recursive: true });
      } else throw new Error(`unexpected Btrfs operation ${args}`);
      return { stdout: "", stderr: "", exit_code: 0 };
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function expectHistory(path: string) {
    expect((await readdir(join(path, ".snapshots"))).sort()).toEqual([
      ".checkpoint-b.lock",
      ...names,
    ]);
    for (const name of names) {
      expect(
        await readFile(join(path, ".snapshots", name, "data"), "utf8"),
      ).toBe(name);
    }
  }

  it("preserves all history and current locks, including on a second restore", async () => {
    for (let i = 0; i < 2; i++) {
      copied = [];
      await preserveSnapshotHistory({ home, replacement, copied });
      expect(copied.sort()).toEqual(names);
      await expectHistory(home);
      await expectHistory(replacement);
      await replaceSnapshotHome({
        home,
        replacement,
        retired,
        record: jest.fn(),
      });
      await deleteRedundantSnapshotHome({ home: retired, copied });
      await expectHistory(home);
      expect(await readFile(join(home, "data"), "utf8")).toBe("restored");
      await mkdir(join(replacement, ".snapshots"), { recursive: true });
      await writeFile(join(replacement, "data"), "restored");
    }
  });

  it("keeps the original history intact when copying fails partway through", async () => {
    runBtrfs
      .mockImplementationOnce(async () => {
        await cp(
          join(home, ".snapshots", names[0]),
          join(replacement, ".snapshots", names[0]),
          { recursive: true },
        );
        return { stdout: "", stderr: "", exit_code: 0 };
      })
      .mockRejectedValueOnce(new Error("out of space"));
    await expect(
      preserveSnapshotHistory({ home, replacement, copied }),
    ).rejects.toThrow("out of space");
    expect(copied).toEqual([names[0]]);
    await deleteRedundantSnapshotHome({ home: replacement, copied });
    await expectHistory(home);
    expect(await readFile(join(home, "data"), "utf8")).toBe("current");
  });

  it("does not silently omit an unexpected history entry", async () => {
    await symlink(
      join(home, ".snapshots", names[0]),
      join(home, ".snapshots", "unexpected"),
    );
    await expect(
      preserveSnapshotHistory({ home, replacement, copied }),
    ).rejects.toThrow("unexpected snapshot history entry");
    expect(runSudo).not.toHaveBeenCalled();
    expect(runBtrfs).not.toHaveBeenCalled();
  });

  it.each(["install", "record"])(
    "rolls back a failed %s without deleting original history",
    async (stage) => {
      await preserveSnapshotHistory({ home, replacement, copied });
      const record = jest.fn().mockResolvedValue(undefined);
      if (stage === "install") {
        runSudo
          .mockImplementationOnce(async () => {
            await rename(home, retired);
            return { stdout: "", stderr: "", exit_code: 0 };
          })
          .mockRejectedValueOnce(new Error("install failed"));
      } else record.mockRejectedValueOnce(new Error("record failed"));
      await expect(
        replaceSnapshotHome({ home, replacement, retired, record }),
      ).rejects.toThrow(`${stage} failed`);
      await deleteRedundantSnapshotHome({ home: replacement, copied });
      await expectHistory(home);
      expect(await readFile(join(home, "data"), "utf8")).toBe("current");
    },
  );

  it("retains original history and reports its location if rollback fails", async () => {
    await preserveSnapshotHistory({ home, replacement, copied });
    runSudo
      .mockImplementationOnce(async () => {
        await rename(home, retired);
        return { stdout: "", stderr: "", exit_code: 0 };
      })
      .mockRejectedValue(new Error("rename failed"));
    await expect(
      replaceSnapshotHome({ home, replacement, retired, record: jest.fn() }),
    ).rejects.toThrow(`original HOME retained at ${retired}`);
    await expectHistory(retired);
    await expectHistory(replacement);
  });

  it("does not touch history if retiring the original HOME fails", async () => {
    await preserveSnapshotHistory({ home, replacement, copied });
    runSudo.mockRejectedValueOnce(new Error("retire failed"));
    await expect(
      replaceSnapshotHome({ home, replacement, retired, record: jest.fn() }),
    ).rejects.toThrow("retire failed");
    await deleteRedundantSnapshotHome({ home: replacement, copied });
    await expectHistory(home);
  });

  it("does not delete an unlisted snapshot during redundant HOME cleanup", async () => {
    runBtrfs.mockRejectedValueOnce(new Error("subvolume is not empty"));
    await expect(
      deleteRedundantSnapshotHome({ home: retired, copied: [] }),
    ).rejects.toThrow("subvolume is not empty");
    expect(runBtrfs).toHaveBeenCalledTimes(1);
    expect(runBtrfs).toHaveBeenCalledWith(
      expect.objectContaining({ args: ["subvolume", "delete", retired] }),
    );
    await expectHistory(home);
  });
});
