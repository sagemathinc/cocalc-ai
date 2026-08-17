import { descendantSubvolumePaths } from "./restore-staging";

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
