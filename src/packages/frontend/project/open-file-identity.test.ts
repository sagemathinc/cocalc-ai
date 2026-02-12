import { fromJS } from "immutable";

import {
  canonicalPath,
  findOpenDisplayPathForSyncPath,
} from "./open-file";
import { syncdbPath as ipynbSyncdbPath } from "@cocalc/util/jupyter/names";
import { termPath } from "@cocalc/util/terminal/names";

describe("canonicalPath", () => {
  it("maps ipynb to its syncdb identity", () => {
    expect(canonicalPath("/root/notebook.ipynb")).toBe(
      ipynbSyncdbPath("/root/notebook.ipynb"),
    );
  });

  it("maps non-hidden term files to numbered term identity", () => {
    expect(canonicalPath("/root/shell.term")).toBe(
      termPath({ path: "/root/shell.term", cmd: "", number: 0 }),
    );
  });

  it("keeps hidden term files unchanged", () => {
    expect(canonicalPath("/root/.shell.term")).toBe("/root/.shell.term");
  });
});

describe("findOpenDisplayPathForSyncPath", () => {
  function mkActions(openFilesObj) {
    return {
      get_store: () =>
        fromJS({
          open_files: openFilesObj,
        }),
    } as any;
  }

  it("finds an already-open alias tab by matching sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(findOpenDisplayPathForSyncPath(actions, "/root/real.txt")).toBe(
      "/root/link.txt",
    );
  });

  it("ignores the excluded display path", () => {
    const actions = mkActions({
      "/root/link.txt": { sync_path: "/root/real.txt" },
    });
    expect(
      findOpenDisplayPathForSyncPath(actions, "/root/real.txt", "/root/link.txt"),
    ).toBeUndefined();
  });

  it("ignores tabs that do not have a sync_path", () => {
    const actions = mkActions({
      "/root/link.txt": { ext: "txt" },
      "/root/other.txt": { sync_path: "/root/other.txt" },
    });
    expect(findOpenDisplayPathForSyncPath(actions, "/root/real.txt")).toBeUndefined();
  });
});
