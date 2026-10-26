const sudo = jest.fn();
const exists = jest.fn();

jest.mock("@cocalc/file-server/btrfs/util", () => ({
  btrfs: jest.fn(async () => ({ exit_code: 0, stdout: "", stderr: "" })),
  sudo: (...args: any[]) => sudo(...args),
}));
jest.mock("@cocalc/file-server/btrfs/subvolume", () => ({
  isBtrfsSubvolume: jest.fn(async () => true),
}));
jest.mock("@cocalc/backend/misc/async-utils-node", () => ({
  exists: (...args: any[]) => exists(...args),
}));

import {
  descendantSubvolumePaths,
  finalizeRestoreStaging,
} from "./restore-staging";

describe("staged restore subvolume cleanup", () => {
  it("returns only descendants, deepest first", () => {
    const parent = "/mnt/cocalc/project-a.restore_old.123";
    const stdout = [
      "ID 10 gen 2 top level 5 path project-a.restore_old.123/.snapshots/one",
      "ID 11 gen 2 top level 10 path project-a.restore_old.123/.snapshots/one/nested",
      "ID 12 gen 2 top level 5 path project-b/.snapshots/unrelated",
      "ID 13 gen 2 top level 5 path project-a.restore_old.1234/not-a-child",
    ].join("\n");

    expect(
      descendantSubvolumePaths({
        stdout,
        mountRoot: "/mnt/cocalc",
        parent,
      }),
    ).toEqual([`${parent}/.snapshots/one/nested`, `${parent}/.snapshots/one`]);
  });
});

describe("finalizeRestoreStaging", () => {
  const handle: any = {
    project_id: "11111111-1111-4111-8111-111111111111",
    home: "/mnt/cocalc/project-a",
    stagingPath: "/mnt/cocalc/.restore-staging/project-a",
  };

  beforeEach(() => {
    sudo.mockReset();
    exists.mockReset().mockResolvedValue(true);
  });

  it("puts the home back when the staged home can't be moved in", async () => {
    const moves: string[][] = [];
    sudo.mockImplementation(async ({ command, args }) => {
      if (command !== "mv") return { exit_code: 0, stdout: "", stderr: "" };
      moves.push(args);
      if (args[0] === handle.stagingPath) throw new Error("mv failed");
      return { exit_code: 0, stdout: "", stderr: "" };
    });
    await expect(finalizeRestoreStaging(handle)).rejects.toThrow("mv failed");
    expect(moves).toEqual([
      [handle.home, expect.stringMatching(/\.restore_old\./)],
      [handle.stagingPath, handle.home],
      [expect.stringMatching(/\.restore_old\./), handle.home],
    ]);
  });

  it("reports both errors when the home can't be put back either", async () => {
    sudo.mockImplementation(async ({ command, args }) => {
      if (command === "mv" && args[1] === handle.home) {
        throw new Error(args[0] === handle.stagingPath ? "first" : "second");
      }
      return { exit_code: 0, stdout: "", stderr: "" };
    });
    await expect(finalizeRestoreStaging(handle)).rejects.toThrow(
      /rollback failed.*first.*second/,
    );
  });
});
