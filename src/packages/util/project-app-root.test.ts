/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appRootMountBase } from "./project-app-root";

describe("appRootMountBase", () => {
  it("is the normalized base path of a prefix-stripping app", () => {
    expect(appRootMountBase({ base_path: "/apps/foo" })).toBe("/apps/foo");
    expect(appRootMountBase({ base_path: "apps/foo/" })).toBe("/apps/foo");
    expect(
      appRootMountBase({ base_path: "/apps/foo", strip_prefix: true }),
    ).toBe("/apps/foo");
  });

  it("refuses apps that keep their prefix", () => {
    expect(
      appRootMountBase({ base_path: "/apps/foo", strip_prefix: false }),
    ).toBeUndefined();
  });

  it("refuses a missing, root or unsafe base path", () => {
    expect(appRootMountBase(undefined)).toBeUndefined();
    expect(appRootMountBase({})).toBeUndefined();
    expect(appRootMountBase({ base_path: "/" })).toBeUndefined();
    expect(appRootMountBase({ base_path: "///" })).toBeUndefined();
    expect(appRootMountBase({ base_path: "/a//b" })).toBeUndefined();
    expect(appRootMountBase({ base_path: "/a?b" })).toBeUndefined();
    expect(appRootMountBase({ base_path: "/a#b" })).toBeUndefined();
    expect(appRootMountBase({ base_path: "/a\\b" })).toBeUndefined();
  });
});
