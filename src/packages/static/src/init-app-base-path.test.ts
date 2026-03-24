/*
 *  This file is part of CoCalc: Copyright (C) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { getWebpackPublicPath } from "./webpack-public-path";

describe("getWebpackPublicPath", () => {
  it("keeps a trailing slash at host root", () => {
    expect(getWebpackPublicPath("/")).toBe("/static/");
  });

  it("keeps a trailing slash for prefixed installs", () => {
    expect(getWebpackPublicPath("/base")).toBe("/base/static/");
  });
});
