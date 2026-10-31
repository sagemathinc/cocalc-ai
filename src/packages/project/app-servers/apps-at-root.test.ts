/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appServedAtRoot, appsAtRoot } from "./apps-at-root";

describe("appsAtRoot (phase 7c)", () => {
  it("is on only when the host says apps run at the root of their origin", () => {
    expect(appsAtRoot({ COCALC_PROJECT_APPS_AT_ROOT: "1" })).toBe(true);
    expect(appsAtRoot({})).toBe(false);
    expect(appsAtRoot({ COCALC_PROJECT_APPS_AT_ROOT: "true" })).toBe(false);
  });
});

describe("appServedAtRoot", () => {
  const atRoot = { COCALC_PROJECT_APPS_AT_ROOT: "1" };

  it("runs a prefix-stripping app with its own base path at the root", () => {
    expect(appServedAtRoot({ base_path: "/apps/foo" }, atRoot)).toBe(true);
    expect(
      appServedAtRoot({ base_path: "/apps/foo", strip_prefix: true }, atRoot),
    ).toBe(true);
  });

  it("keeps the base URL of an app that keeps its prefix", () => {
    // the host refuses to mount it at the root (appRootMountForKey)
    expect(
      appServedAtRoot({ base_path: "/apps/foo", strip_prefix: false }, atRoot),
    ).toBe(false);
  });

  it("keeps the base URL where the host can't mount the app at the root", () => {
    expect(appServedAtRoot({ base_path: "/" }, atRoot)).toBe(false);
    expect(appServedAtRoot({}, atRoot)).toBe(false);
    expect(appServedAtRoot(undefined, atRoot)).toBe(false);
  });

  it("is off on hosts without app origins", () => {
    expect(appServedAtRoot({ base_path: "/apps/foo" }, {})).toBe(false);
  });
});
