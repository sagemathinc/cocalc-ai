import { executeCode } from "@cocalc/backend/execute-code";
import { withBtrfsMutationContext } from "./mutation-context";
import { withBtrfsMutationLock } from "./operation-cache";
import { btrfs, btrfsCommandOnlyReads } from "./util";

jest.mock("@cocalc/backend/execute-code", () => ({
  executeCode: jest.fn(),
}));

const mockedExecuteCode = jest.mocked(executeCode);

describe("btrfs privileged command routing", () => {
  beforeEach(() => {
    mockedExecuteCode.mockReset();
    mockedExecuteCode.mockResolvedValue({
      type: "blocking",
      stdout: "",
      stderr: "",
      exit_code: 0,
    } as any);
  });

  it("uses the normal command for interactive mutations", async () => {
    await btrfs({ args: ["subvolume", "show", "/mnt/cocalc"] });

    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sudo",
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "btrfs",
          "subvolume",
          "show",
          "/mnt/cocalc",
        ],
      }),
    );
  });

  it("moves scheduled reads through the maintenance command", async () => {
    await withBtrfsMutationContext({ priority: "scheduled" }, async () => {
      await btrfs({ args: ["qgroup", "show", "-reF", "/mnt/cocalc"] });
    });

    expect(mockedExecuteCode).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "sudo",
        args: [
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "btrfs-maintenance",
          "qgroup",
          "show",
          "-reF",
          "/mnt/cocalc",
        ],
      }),
    );
  });

  // Prod 10-30: a commit forced from the io.max-capped maintenance cgroup
  // (e.g. a backup's temporary snapshot made read-only) took 5-45 s, and
  // every fsync on the host waited for it.
  it("never runs a command that commits through the maintenance command", async () => {
    const writes = [
      ["subvolume", "snapshot", "-r", "/mnt/source", "/mnt/dest"],
      ["subvolume", "delete", "/mnt/dest"],
      ["subvolume", "create", "/mnt/dest"],
      ["property", "set", "-ts", "/mnt/dest", "ro", "true"],
      ["qgroup", "limit", "1000", "/mnt/dest", "/mnt"],
      ["qgroup", "assign", "--no-rescan", "/mnt/dest", "1/1", "/mnt"],
      ["quota", "disable", "/mnt"],
      ["qgroup", "show", "--sync", "-reF", "/mnt"],
      ["device", "stats", "--reset", "/mnt"],
      ["some-future", "command"],
    ];
    for (const priority of ["scheduled", "scavenger"] as const) {
      for (const args of writes) {
        mockedExecuteCode.mockClear();
        await withBtrfsMutationContext({ priority }, async () => {
          await btrfs({ args });
        });
        expect(mockedExecuteCode.mock.calls[0][0].args).toEqual([
          "-n",
          "/usr/local/sbin/cocalc-runtime-storage",
          "btrfs",
          ...args,
        ]);
      }
    }
  });

  it("classifies only reading subcommands as reads", () => {
    for (const args of [
      ["subvolume", "show", "/mnt/x"],
      ["subvolume", "list", "-o", "/mnt"],
      ["qgroup", "show", "-reF", "/mnt"],
      ["property", "get", "-ts", "/mnt/x", "ro"],
      ["filesystem", "du", "-s", "/mnt/x"],
      ["inspect-internal", "rootid", "/mnt/x"],
      ["device", "stats", "-c", "/mnt"],
      ["qgroup", "show", "--raw", "/mnt"],
    ]) {
      expect(btrfsCommandOnlyReads(args)).toBe(true);
    }
    for (const args of [
      ["subvolume", "snapshot", "/a", "/b"],
      ["property", "set", "-ts", "/mnt/x", "ro", "true"],
      ["qgroup", "destroy", "1/1", "/mnt"],
      ["filesystem", "resize", "max", "/mnt"],
      // @review on #1516: options that make a listed subcommand write
      ["qgroup", "show", "--sync", "/mnt"],
      ["device", "stats", "-z", "/mnt"],
      ["device", "stats", "-cz", "/mnt"],
      ["device", "stats", "--reset", "/mnt"],
      // only the listed inspect-internal commands, and no prototype keys
      ["inspect-internal", "some-future-command", "/mnt"],
      ["constructor", "name"],
      ["subvolume", "constructor"],
      [],
    ]) {
      expect(btrfsCommandOnlyReads(args)).toBe(false);
    }
  });

  it("promotes only the lock-held scheduled transaction", async () => {
    await withBtrfsMutationContext({ priority: "scheduled" }, async () => {
      await btrfs({ args: ["subvolume", "show", "/mnt/source"] });
      await withBtrfsMutationLock({
        mount: "/mnt/test",
        operation: "snapshot-create",
        run: async () => {
          await btrfs({
            args: ["subvolume", "snapshot", "-r", "/mnt/source", "/mnt/dest"],
          });
        },
      });
    });

    expect(mockedExecuteCode.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining([
          "btrfs-maintenance",
          "subvolume",
          "show",
        ]),
      }),
    );
    expect(mockedExecuteCode.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        args: expect.arrayContaining(["btrfs", "subvolume", "snapshot"]),
      }),
    );
  });
});
