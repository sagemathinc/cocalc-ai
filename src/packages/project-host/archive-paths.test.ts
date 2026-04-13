/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { normalizeArchivePath } from "./archive-path";

describe("archive path normalization", () => {
  it("converts runtime home absolute paths to project-relative paths", () => {
    expect(normalizeArchivePath("/home/user/a.txt")).toBe("a.txt");
    expect(normalizeArchivePath("/root/a.txt")).toBe("a.txt");
  });

  it("preserves already-relative archive paths", () => {
    expect(normalizeArchivePath("dir/file.txt")).toBe("dir/file.txt");
    expect(normalizeArchivePath("./dir/file.txt")).toBe("dir/file.txt");
  });

  it("normalizes archive glob patterns rooted in the runtime home", () => {
    expect(normalizeArchivePath("/home/user/**/*.txt")).toBe("**/*.txt");
  });
});
