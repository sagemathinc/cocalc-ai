/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  authViewUrl,
  getSafeAuthRedirectTargetFromSearch,
  signedInRedirectUrl,
} from "./util";

describe("auth util redirects", () => {
  it("accepts safe same-origin redirect targets", () => {
    expect(
      getSafeAuthRedirectTargetFromSearch(
        `?target=${encodeURIComponent("/claim/site-license?token=abc#done")}`,
      ),
    ).toBe("/claim/site-license?token=abc#done");
    expect(
      signedInRedirectUrl(
        `?target=${encodeURIComponent("/claim/site-license?token=abc")}`,
      ),
    ).toBe("/claim/site-license?token=abc");
  });

  it("rejects external or empty redirect targets", () => {
    expect(
      getSafeAuthRedirectTargetFromSearch(
        `?target=${encodeURIComponent("https://evil.example/claim")}`,
      ),
    ).toBeUndefined();
    expect(
      getSafeAuthRedirectTargetFromSearch(
        `?target=${encodeURIComponent("//evil.example/claim")}`,
      ),
    ).toBeUndefined();
    expect(
      getSafeAuthRedirectTargetFromSearch(`?target=${encodeURIComponent("/")}`),
    ).toBeUndefined();
  });

  it("unwraps auth redirects and preserves target when switching auth views", () => {
    const nested = `/auth/sign-in?target=${encodeURIComponent("/claim/site-license?token=abc")}`;
    expect(
      getSafeAuthRedirectTargetFromSearch(
        `?target=${encodeURIComponent(nested)}`,
      ),
    ).toBe("/claim/site-license?token=abc");
    expect(
      authViewUrl(
        "sign-up",
        `?target=${encodeURIComponent("/claim/site-license?token=abc")}`,
      ),
    ).toBe("/auth/sign-up?target=%2Fclaim%2Fsite-license%3Ftoken%3Dabc");
  });
});
