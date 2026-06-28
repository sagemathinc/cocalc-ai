/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  publicDirectoryShareUrlForDisplayPath,
  publicDirectoryShareUrlForLocalUrl,
} from "./public-directory-share-url";

describe("public directory share URL helpers", () => {
  it("maps project files routes back to durable share URLs", () => {
    expect(
      publicDirectoryShareUrlForLocalUrl({
        localUrl: "files/",
        shareRoot: "/home/user/share",
        slug: "test2",
      }),
    ).toBe("/share/test2");
    expect(
      publicDirectoryShareUrlForLocalUrl({
        localUrl: "files/home/user/share/x/y.txt",
        shareRoot: "/home/user/share",
        slug: "test2",
      }),
    ).toBe("/share/test2/x/y.txt");
  });

  it("encodes slug and file path segments independently", () => {
    expect(
      publicDirectoryShareUrlForLocalUrl({
        localUrl: "files/home/user/share/a b/π.md",
        shareRoot: "/home/user/share",
        slug: "Course Shares/test 2",
      }),
    ).toBe("/share/Course%20Shares/test%202/a%20b/%CF%80.md");
  });

  it("falls back to the share root for project files outside the shared root", () => {
    expect(
      publicDirectoryShareUrlForLocalUrl({
        localUrl: "files/home/user/private/secret.txt",
        shareRoot: "/home/user/share",
        slug: "test2",
      }),
    ).toBe("/share/test2");
  });

  it("maps open-file display paths inside a folder share", () => {
    expect(
      publicDirectoryShareUrlForDisplayPath({
        displayPath: "/home/user/share/a.md",
        projectHome: "/home/user",
        sharePath: "share",
        slug: "test2",
      }),
    ).toBe("/share/test2/a.md");
  });

  it("maps whole-project share display paths relative to project HOME", () => {
    expect(
      publicDirectoryShareUrlForDisplayPath({
        displayPath: "/home/user/notebooks/a.ipynb",
        projectHome: "/home/user",
        sharePath: ".",
        slug: "whole",
      }),
    ).toBe("/share/whole/notebooks/a.ipynb");
  });

  it("does not rewrite open-file history for display paths outside the share", () => {
    expect(
      publicDirectoryShareUrlForDisplayPath({
        displayPath: "/home/user/private/secret.txt",
        projectHome: "/home/user",
        sharePath: "share",
        slug: "test2",
      }),
    ).toBeUndefined();
  });
});
