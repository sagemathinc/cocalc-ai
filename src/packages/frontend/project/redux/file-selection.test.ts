/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { List, Set as ImmutableSet } from "immutable";

import {
  nextSelectedFileIndex,
  selectedFileRange,
  setFileCheckedState,
  setFileListCheckedState,
  setFileListUncheckedState,
  suggestDuplicateFilenameInDirectory,
  uniqueFileActionPaths,
} from "./file-selection";

describe("project redux file selection", () => {
  it("moves selected file index within displayed bounds", () => {
    expect(
      nextSelectedFileIndex({
        selectedFileIndex: undefined,
        numDisplayedFiles: 2,
        delta: 1,
      }),
    ).toBe(1);
    expect(
      nextSelectedFileIndex({
        selectedFileIndex: 1,
        numDisplayedFiles: 2,
        delta: 1,
      }),
    ).toBeUndefined();
    expect(
      nextSelectedFileIndex({
        selectedFileIndex: 2,
        delta: -1,
      }),
    ).toBe(1);
  });

  it("builds a selected file range from listing names", () => {
    expect(
      selectedFileRange({
        file: "/work/c.txt",
        currentPath: "/work",
        mostRecentFileClick: "/work/a.txt",
        listing: [{ name: "a.txt" }, { name: "b.txt" }, { name: "c.txt" }],
      }),
    ).toEqual(["/work/a.txt", "/work/b.txt", "/work/c.txt"]);
  });

  it("clears single-file actions when selecting multiple files", () => {
    const changes = setFileCheckedState({
      checkedFiles: ImmutableSet(["/a.txt"]),
      fileAction: "rename",
      allowsMultipleFiles: (action) => action !== "rename",
      file: "/b.txt",
      checked: true,
    });

    expect(changes.checked_files?.toArray().sort()).toEqual([
      "/a.txt",
      "/b.txt",
    ]);
    expect(changes.file_action).toBeUndefined();
  });

  it("clears the action when the final checked file is unchecked", () => {
    const changes = setFileListUncheckedState({
      checkedFiles: ImmutableSet(["/a.txt"]),
      fileList: List(["/a.txt"]),
    });

    expect(changes.checked_files.size).toBe(0);
    expect(changes.file_action).toBeUndefined();
  });

  it("preserves multi-file actions when checking a list", () => {
    const changes = setFileListCheckedState({
      checkedFiles: ImmutableSet(["/a.txt"]),
      fileAction: "delete",
      allowsMultipleFiles: () => true,
      fileList: ["/b.txt"],
    });

    expect(changes.checked_files.toArray().sort()).toEqual([
      "/a.txt",
      "/b.txt",
    ]);
    expect("file_action" in changes).toBe(false);
  });

  it("suggests an unused duplicate filename", () => {
    expect(
      suggestDuplicateFilenameInDirectory({
        name: "notes.txt",
        filesInDir: {
          "notes-1.txt": true,
        },
      }),
    ).toBe("notes-2.txt");
  });

  it("normalizes action paths to non-empty unique values", () => {
    expect(uniqueFileActionPaths(["/a", "", "/a", "/b"])).toEqual(["/a", "/b"]);
  });
});
