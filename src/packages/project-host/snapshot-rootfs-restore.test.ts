import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  rename,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sudo } from "@cocalc/file-server/btrfs/util";
import { restoreSnapshotRootfs } from "./snapshot-rootfs-restore";

jest.mock("@cocalc/file-server/btrfs/util", () => ({ sudo: jest.fn() }));

let root: string;
let current: string;
let snapshot: string;
let fail: (command: string, args: string[]) => boolean;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cocalc-rootfs-restore-"));
  current = join(root, "home", "rootfs");
  snapshot = join(root, "clone", "rootfs");
  for (const [path, content] of [
    [current, "current"],
    [snapshot, "snapshot"],
  ]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "marker"), content);
  }
  fail = () => false;
  jest
    .mocked(sudo)
    .mockReset()
    .mockImplementation(async ({ command, args }: any) => {
      if (fail(command, args)) throw Error("injected storage failure");
      if (command === "mv") {
        if (args[0].startsWith(join(root, "clone"))) throw Error("EXDEV");
        await rename(args[0], args[1]);
      } else if (command === "copy-tree-reflink") {
        await cp(args[0], args[1], { recursive: true });
      } else if (command === "mkdir") {
        await mkdir(args[1], { recursive: true });
      } else if (command === "rm") {
        await rm(args[1], { recursive: true, force: true });
      } else throw Error(`unexpected command ${command}`);
      return {} as any;
    });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const marker = (path: string) => readFile(join(path, "marker"), "utf8");
const removed = () =>
  jest
    .mocked(sudo)
    .mock.calls.filter(([x]) => x.command === "rm")
    .map(([x]) => x.args?.[1]);

test("copies across subvolumes before swapping siblings and leaves home and snapshot unchanged", async () => {
  await writeFile(join(root, "home", "untouched"), "home");
  await restoreSnapshotRootfs({ current, snapshot });
  expect(sudo).toHaveBeenCalledWith(
    expect.objectContaining({
      command: "copy-tree-reflink",
      timeout: 60 * 60,
    }),
  );
  expect(await marker(current)).toBe("snapshot");
  expect(await marker(snapshot)).toBe("snapshot");
  expect(await readFile(join(root, "home", "untouched"), "utf8")).toBe("home");
  expect(removed()).not.toContain(current);
  expect(removed()).not.toContain(snapshot);
});

test.each(["copy", "preserve", "install"])(
  "failure at %s preserves the live rootfs",
  async (stage) => {
    fail = (command, args) =>
      stage === "copy"
        ? command === "copy-tree-reflink"
        : command === "mv" &&
          (stage === "preserve"
            ? args[0] === current
            : args[0].includes(".restore-new-"));
    await expect(restoreSnapshotRootfs({ current, snapshot })).rejects.toThrow(
      "injected storage failure",
    );
    expect(await marker(current)).toBe("current");
    expect(await marker(snapshot)).toBe("snapshot");
  },
);

test("failed rollback retains the previous rootfs instead of cleaning it up", async () => {
  fail = (command, args) => command === "mv" && args[0] !== current;
  await expect(restoreSnapshotRootfs({ current, snapshot })).rejects.toThrow(
    "previous rootfs retained",
  );
  const previous = jest
    .mocked(sudo)
    .mock.calls.find(([x]) => x.command === "mv" && x.args?.[0] === current)![0]
    .args![1];
  expect(await marker(previous)).toBe("current");
  expect(removed()).not.toContain(previous);
});

test("a snapshot without rootfs removes the current rootfs without replacing home", async () => {
  await rm(snapshot, { recursive: true });
  await restoreSnapshotRootfs({ current, snapshot });
  await expect(access(current)).rejects.toThrow();
  await expect(access(join(root, "home"))).resolves.toBeUndefined();
});

test("a previously absent rootfs is installed", async () => {
  await rm(current, { recursive: true });
  await restoreSnapshotRootfs({ current, snapshot });
  expect(await marker(current)).toBe("snapshot");
});

test("refuses the same live and snapshot path before any mutation", async () => {
  await expect(
    restoreSnapshotRootfs({ current, snapshot: current }),
  ).rejects.toThrow("differ");
  expect(sudo).not.toHaveBeenCalled();
});
