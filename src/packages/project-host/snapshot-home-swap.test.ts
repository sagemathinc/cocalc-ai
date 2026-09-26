import { sudo } from "@cocalc/file-server/btrfs/util";
import { SnapshotHomeSwapError, swapSnapshotHome } from "./snapshot-home-swap";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("@cocalc/file-server/btrfs/util", () => ({ sudo: jest.fn() }));

const paths = {
  home: "/home",
  replacement: "/replacement",
  previous: "/previous",
};
let trees: Map<string, string>;
let failures: Set<number>;
let moveCount: number;
let record: jest.Mock;
beforeEach(() => {
  jest.resetAllMocks();
  trees = new Map([
    [paths.home, "original"],
    [paths.replacement, "snapshot"],
  ]);
  failures = new Set();
  moveCount = 0;
  record = jest.fn(async () => {});
  (sudo as jest.Mock).mockImplementation(async ({ command, args }) => {
    expect(command).toBe("mv");
    if (failures.has(++moveCount)) throw Error(`move ${moveCount} failed`);
    const [source, destination] = args;
    if (!trees.has(source) || trees.has(destination))
      throw Error("invalid tree move");
    trees.set(destination, trees.get(source)!);
    trees.delete(source);
  });
});

test("successful swap retains the original tree until caller finalizes", async () => {
  await swapSnapshotHome({ ...paths, record });
  expect(trees.get(paths.home)).toBe("snapshot");
  expect(trees.get(paths.previous)).toBe("original");
  expect(record).toHaveBeenCalledTimes(1);
});

test.each([1, 2])(
  "move %i failure leaves or restores original home",
  async (step) => {
    failures.add(step);
    await expect(swapSnapshotHome({ ...paths, record })).rejects.toThrow(
      `move ${step} failed`,
    );
    expect(trees.get(paths.home)).toBe("original");
    expect(trees.get(paths.replacement)).toBe("snapshot");
    expect(record).toHaveBeenCalledTimes(1);
  },
);

test("metadata failure rolls back both trees and records original volume again", async () => {
  record.mockRejectedValueOnce(Error("metadata failed"));
  await expect(swapSnapshotHome({ ...paths, record })).rejects.toThrow(
    "metadata failed",
  );
  expect(trees.get(paths.home)).toBe("original");
  expect(trees.get(paths.replacement)).toBe("snapshot");
  expect(record).toHaveBeenCalledTimes(2);
});

test.each([3, 4])(
  "rollback move %i failure retains original tree and both errors",
  async (step) => {
    record.mockRejectedValueOnce(Error("metadata failed"));
    failures.add(step);
    const error = await swapSnapshotHome({ ...paths, record }).catch((e) => e);
    expect(error).toBeInstanceOf(SnapshotHomeSwapError);
    expect(error.errors.map((e) => e.message)).toEqual([
      "metadata failed",
      `move ${step} failed`,
    ]);
    expect(trees.get(paths.previous)).toBe("original");
    expect([...trees.values()].sort()).toEqual(["original", "snapshot"]);
  },
);

test("rollback metadata failure reports both failures with original home restored", async () => {
  record.mockRejectedValue(Error("metadata unavailable"));
  await expect(swapSnapshotHome({ ...paths, record })).rejects.toBeInstanceOf(
    SnapshotHomeSwapError,
  );
  expect(trees.get(paths.home)).toBe("original");
  expect(trees.get(paths.replacement)).toBe("snapshot");
});

test("metadata failure restores real directory contents without deleting replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cocalc-snapshot-swap-"));
  const real = {
    home: join(root, "home"),
    replacement: join(root, "replacement"),
    previous: join(root, "previous"),
  };
  try {
    await mkdir(real.home);
    await mkdir(real.replacement);
    await writeFile(join(real.home, "marker"), "original rootfs and home");
    await writeFile(join(real.replacement, "marker"), "prepared snapshot");
    (sudo as jest.Mock).mockImplementation(async ({ command, args }) => {
      expect(command).toBe("mv");
      await rename(args[0], args[1]);
    });
    record.mockRejectedValueOnce(Error("record failed"));
    await expect(swapSnapshotHome({ ...real, record })).rejects.toThrow(
      "record failed",
    );
    expect(await readFile(join(real.home, "marker"), "utf8")).toBe(
      "original rootfs and home",
    );
    expect(await readFile(join(real.replacement, "marker"), "utf8")).toBe(
      "prepared snapshot",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
