import {
  descendantSubvolumePaths,
  validateRestoreStagingHandle,
} from "./restore-staging";
import type { RestoreStagingHandle } from "@cocalc/conat/files/file-server";

const project_id = "00000000-0000-4000-8000-000000000001";
const home = `/mnt/cocalc/project-${project_id}`;
const stagingRoot = "/mnt/cocalc/.restore-staging";
const handle: RestoreStagingHandle = {
  project_id,
  home,
  stagingRoot,
  stagingPath: `${stagingRoot}/project-${project_id}`,
  markerPath: `${stagingRoot}/.restore_in_progress.${project_id}`,
  restore: "required",
  homeExists: false,
};

it.each(["auto", "recover", "required"] as const)(
  "accepts a canonical %s handle",
  (restore) => {
    expect(() =>
      validateRestoreStagingHandle({ ...handle, restore }, home),
    ).not.toThrow();
  },
);

it.each([
  "home",
  "stagingRoot",
  "stagingPath",
  "markerPath",
  "project_id",
] as const)("rejects a forged %s before storage work", (field) => {
  expect(() =>
    validateRestoreStagingHandle(
      { ...handle, [field]: "/mnt/cocalc/another-project" },
      home,
    ),
  ).toThrow();
});

it("rejects cross-project handles even when their own paths are internally consistent", () => {
  expect(() =>
    validateRestoreStagingHandle(handle, "/mnt/cocalc/project-other"),
  ).toThrow();
  expect(() =>
    validateRestoreStagingHandle({ ...handle, restore: "none" }, home),
  ).toThrow();
});

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
