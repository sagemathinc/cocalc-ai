/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isSupportedSSOStrategy } from "./get-sso-strategies";

describe("isSupportedSSOStrategy", () => {
  it("keeps Google as the only supported built-in public SSO provider", () => {
    expect(isSupportedSSOStrategy("google", true)).toBe(true);
    expect(isSupportedSSOStrategy("github", true)).toBe(false);
    expect(isSupportedSSOStrategy("facebook", true)).toBe(false);
    expect(isSupportedSSOStrategy("twitter", true)).toBe(false);
  });

  it("allows custom organization providers", () => {
    expect(isSupportedSSOStrategy("cornell", false)).toBe(true);
    expect(isSupportedSSOStrategy("cornell", true)).toBe(true);
  });
});
