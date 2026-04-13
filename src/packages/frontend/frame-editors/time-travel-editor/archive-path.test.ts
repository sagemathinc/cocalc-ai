/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

jest.mock("@cocalc/frontend/project/home-directory", () => ({
  getProjectHomeDirectory: jest.fn(() => "/home/user"),
}));

import { toArchiveRelativePath } from "./archive-path";

describe("time-travel archive path normalization", () => {
  it("converts runtime home absolute document paths to archive-relative paths", () => {
    expect(toArchiveRelativePath("project-1", "/home/user/a.txt")).toBe(
      "a.txt",
    );
  });

  it("preserves already-relative document paths", () => {
    expect(toArchiveRelativePath("project-1", "dir/file.txt")).toBe(
      "dir/file.txt",
    );
  });
});
