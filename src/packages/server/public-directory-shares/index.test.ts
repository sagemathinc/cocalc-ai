/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  normalizePublicDirectorySharePath,
  normalizePublicDirectoryShareSlug,
  publicDirectoryShareReadPolicyForPath,
} from "./index";
import { viewerReadPolicyAllowsPath } from "@cocalc/util/project-access";

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

  it("generates path-scoped read policies", () => {
    const policy = publicDirectoryShareReadPolicyForPath("Cambridge/Code");
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Code",
      }),
    ).toBe(true);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Code/notebook.ipynb",
      }),
    ).toBe(true);
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: "Cambridge/Other",
      }),
    ).toBe(false);
  });

  it("excludes sensitive project paths even from root shares", () => {
    const policy = publicDirectoryShareReadPolicyForPath(".");
    expect(viewerReadPolicyAllowsPath({ policy, path: "README.md" })).toBe(
      true,
    );
    expect(viewerReadPolicyAllowsPath({ policy, path: ".ssh" })).toBe(false);
    expect(
      viewerReadPolicyAllowsPath({ policy, path: ".ssh/authorized_keys" }),
    ).toBe(false);
    expect(viewerReadPolicyAllowsPath({ policy, path: ".snapshots" })).toBe(
      false,
    );
    expect(
      viewerReadPolicyAllowsPath({
        policy,
        path: ".local/share/cocalc/project-log.db",
      }),
    ).toBe(false);
  });
});
