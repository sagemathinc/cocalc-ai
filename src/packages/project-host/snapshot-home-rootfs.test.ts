import { exists } from "@cocalc/backend/misc/async-utils-node";
import { sudo } from "@cocalc/file-server/btrfs/util";
import { prepareHomeSnapshotRootfs } from "./snapshot-home-rootfs";

jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: jest.fn(),
}));
jest.mock("@cocalc/file-server/btrfs/util", () => ({ sudo: jest.fn() }));

const paths = {
  current: "/volume/home/rootfs",
  staged: "/volume/clone/rootfs",
};
beforeEach(() => {
  jest.resetAllMocks();
  (exists as jest.Mock).mockResolvedValue(true);
  (sudo as jest.Mock).mockResolvedValue({ exit_code: 0 });
});

test("replaces only staged rootfs through the anchored reflink helper", async () => {
  await prepareHomeSnapshotRootfs(paths);
  expect((sudo as jest.Mock).mock.calls).toEqual([
    [{ command: "rm", args: ["-rf", paths.staged] }],
    [
      {
        command: "copy-tree-reflink",
        args: [paths.current, paths.staged],
        timeout: 60 * 60,
      },
    ],
  ]);
});

test("missing current rootfs removes the snapshot's rootfs instead of resurrecting it", async () => {
  (exists as jest.Mock).mockResolvedValue(false);
  await prepareHomeSnapshotRootfs(paths);
  expect(sudo).toHaveBeenCalledTimes(1);
  expect(sudo).toHaveBeenCalledWith({
    command: "rm",
    args: ["-rf", paths.staged],
  });
});

test.each([1, 2])(
  "failure at operation %i never moves or deletes the current rootfs",
  async (step) => {
    let call = 0;
    (sudo as jest.Mock).mockImplementation(async () => {
      if (++call === step) throw Error("storage failure");
    });
    await expect(prepareHomeSnapshotRootfs(paths)).rejects.toThrow(
      "storage failure",
    );
    expect(sudo).toHaveBeenCalledTimes(step);
    for (const [request] of (sudo as jest.Mock).mock.calls) {
      expect(request.command).not.toBe("mv");
      if (request.command === "rm")
        expect(request.args).not.toContain(paths.current);
    }
  },
);

test("refuses a live path used as staging", async () => {
  await expect(
    prepareHomeSnapshotRootfs({
      current: paths.current,
      staged: paths.current,
    }),
  ).rejects.toThrow("staging");
  expect(sudo).not.toHaveBeenCalled();
});
