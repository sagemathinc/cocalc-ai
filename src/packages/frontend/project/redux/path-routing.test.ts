/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { BACKUPS } from "@cocalc/util/consts/backups";
import { SNAPSHOTS } from "@cocalc/util/consts/snapshots";

import {
  fromUrlDirectoryPath,
  getPathRoute,
  getSnapshotHomeDirectoryForPaths,
  getSnapshotsRouteRelativePath,
  isVirtualListingPath,
  toAbsoluteCurrentPath,
  toAuxTabPath,
  toUrlPath,
} from "./path-routing";

describe("project redux path routing", () => {
  it("keeps virtual backup paths relative", () => {
    expect(isVirtualListingPath(`${BACKUPS}/2026-01-01`)).toBe(true);
    expect(
      toAbsoluteCurrentPath({
        path: `${BACKUPS}/2026-01-01`,
        homeDirectory: "/home/user",
      }),
    ).toBe(`${BACKUPS}/2026-01-01`);
    expect(
      getPathRoute({
        path: `/${BACKUPS}/2026-01-01/`,
        homeDirectory: "/home/user",
      }),
    ).toEqual({ relativePath: `${BACKUPS}/2026-01-01` });
  });

  it("routes snapshot paths relative to the project runtime home", () => {
    expect(getSnapshotHomeDirectoryForPaths("/")).toBe("/home/user");
    expect(
      getSnapshotsRouteRelativePath(`/home/user/${SNAPSHOTS}/snap-1/file.txt`),
    ).toBe(`${SNAPSHOTS}/snap-1/file.txt`);
    expect(
      toAbsoluteCurrentPath({
        path: `${SNAPSHOTS}/snap-1`,
        homeDirectory: "/home/user",
      }),
    ).toBe(`/home/user/${SNAPSHOTS}/snap-1`);
  });

  it("encodes file and auxiliary targets with the existing relative route semantics", () => {
    expect(
      toUrlPath({
        path: "/work/notes.md",
        isDirectory: false,
        homeDirectory: "/home/user",
      }),
    ).toBe("files/work/notes.md");
    expect(
      toAuxTabPath({
        tab: "search",
        path: "/",
        homeDirectory: "/home/user",
      }),
    ).toBe("search/");
  });

  it("decodes files targets against the configured home directory", () => {
    expect(
      fromUrlDirectoryPath({
        path: "files",
        homeDirectory: "/home/user",
      }),
    ).toBe("/home/user");
    expect(
      fromUrlDirectoryPath({
        path: "files/work",
        homeDirectory: "/home/user",
      }),
    ).toBe("/work");
    expect(
      fromUrlDirectoryPath({
        path: `files/${SNAPSHOTS}/snap-1`,
        homeDirectory: "/home/user",
      }),
    ).toBe(`/home/user/${SNAPSHOTS}/snap-1`);
  });

  it("keeps home-relative route handling unchanged", () => {
    expect(getPathRoute({ path: "/", homeDirectory: "/home/user" })).toEqual({
      relativePath: "",
    });
    expect(
      getPathRoute({ path: "/home/user/work", homeDirectory: "/home/user" }),
    ).toEqual({ relativePath: "home/user/work" });
  });
});
