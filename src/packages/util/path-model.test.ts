/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  displayPath,
  isAbsolutePath,
  joinAbsolutePath,
  normalizeAbsolutePath,
} from "./path-model";

describe("path-model", () => {
  test("normalizeAbsolutePath handles absolute, relative, and base paths", () => {
    expect(normalizeAbsolutePath("/tmp//a/../b/")).toBe("/tmp/b");
    expect(normalizeAbsolutePath("a/../b", "/tmp//x/")).toBe("/tmp/x/b");
    expect(normalizeAbsolutePath("", "/tmp//x/")).toBe("/tmp/x");
    expect(normalizeAbsolutePath("tmp/a")).toBe("/tmp/a");
    expect(normalizeAbsolutePath("../b", "/tmp")).toBe("/b");
  });

  test("joinAbsolutePath preserves absolute normalization", () => {
    expect(joinAbsolutePath("/tmp//a/", "../b/")).toBe("/tmp/b");
    expect(joinAbsolutePath("/", "x/y")).toBe("/x/y");
  });

  test("displayPath supports home aliasing", () => {
    expect(displayPath("/home/user", "/home/user")).toBe("~");
    expect(displayPath("/home/user/work/file.txt", "/home/user")).toBe(
      "~/work/file.txt",
    );
    expect(displayPath("/tmp/x", "/home/user")).toBe("/tmp/x");
  });

  test("isAbsolutePath detects absolute paths", () => {
    expect(isAbsolutePath("/tmp/x")).toBe(true);
    expect(isAbsolutePath("tmp/x")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });
});
