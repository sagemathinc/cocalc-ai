/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizePublicDirectorySharePath,
  normalizePublicDirectoryShareSlug,
} from "./index";

describe("public directory share normalization", () => {
  it("normalizes slugs", () => {
    expect(normalizePublicDirectoryShareSlug("/Cambridge/Book/Code/")).toBe(
      "Cambridge/Book/Code",
    );
  });

  it("rejects unsafe slugs", () => {
    expect(() => normalizePublicDirectoryShareSlug("")).toThrow(
      "slug must be nonempty",
    );
    expect(() => normalizePublicDirectoryShareSlug("a//b")).toThrow(
      "duplicate slashes",
    );
    expect(() => normalizePublicDirectoryShareSlug("a/../b")).toThrow(
      "path segments",
    );
    expect(() => normalizePublicDirectoryShareSlug("a/\u0000/b")).toThrow(
      "control characters",
    );
  });

  it("normalizes shared project paths", () => {
    expect(normalizePublicDirectorySharePath("")).toBe(".");
    expect(normalizePublicDirectorySharePath(".")).toBe(".");
    expect(normalizePublicDirectorySharePath("/docs/examples/")).toBe(
      "docs/examples",
    );
  });

  it("rejects unsafe project paths", () => {
    expect(() => normalizePublicDirectorySharePath("a//b")).toThrow(
      "duplicate slashes",
    );
    expect(() => normalizePublicDirectorySharePath("a/./b")).toThrow(
      "path segments",
    );
    expect(() => normalizePublicDirectorySharePath("a/../b")).toThrow(
      "path segments",
    );
  });
});
