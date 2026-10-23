/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { appsAtRoot } from "./apps-at-root";

describe("appsAtRoot (phase 7c)", () => {
  it("is on only when the host says apps run at the root of their origin", () => {
    expect(appsAtRoot({ COCALC_PROJECT_APPS_AT_ROOT: "1" })).toBe(true);
    expect(appsAtRoot({})).toBe(false);
    expect(appsAtRoot({ COCALC_PROJECT_APPS_AT_ROOT: "true" })).toBe(false);
  });
});
