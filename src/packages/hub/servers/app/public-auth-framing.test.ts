/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isPublicAuthShellTarget } from "./public-auth-framing";

describe("isPublicAuthShellTarget", () => {
  it.each([
    "/auth/oauth/authorize?response_type=code&client_id=sagebrush",
    "/auth/oauth/authorize/",
    "/auth/x/../oauth/authorize?client_id=sagebrush",
    "/auth/./oauth/authorize",
    "/features/../auth/oauth/authorize",
    "/%2e%2e/auth/oauth/authorize",
    "/base/auth/cli-login/abc",
    "/auth/sign-in",
    "/invites/abc123",
    "/x/../invites/abc123",
    "/sso/google",
    "/redeem/xyz",
    ["/auth/oauth/authorize", "/features"],
  ])("denies framing for %j", (target) => {
    expect(isPublicAuthShellTarget(target)).toBe(true);
  });

  it.each([
    "/features",
    "/authorize",
    "/oauth/authorize",
    "/auth-help",
    "/invitesx/abc",
    "",
    undefined,
    ["/features", "/auth/sign-in"],
  ])("leaves %j alone", (target) => {
    expect(isPublicAuthShellTarget(target)).toBe(false);
  });

  it("classifies like the browser's URL parser", () => {
    const target = "/auth/x/../oauth/authorize?state=1";
    expect(new URL(target, "https://example.invalid").pathname).toBe(
      "/auth/oauth/authorize",
    );
    expect(isPublicAuthShellTarget(target)).toBe(true);
  });
});
