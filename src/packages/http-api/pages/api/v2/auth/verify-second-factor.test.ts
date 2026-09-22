/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const verifySignInSecondFactorChallengeMock = jest.fn();
const completeEmailAuthMfaMock = jest.fn();
const signUserInMock = jest.fn();

jest.mock("@cocalc/server/auth/two-factor", () => ({
  verifySignInSecondFactorChallenge: (...args: any[]) =>
    verifySignInSecondFactorChallengeMock(...args),
}));

jest.mock("@cocalc/server/inter-bay/email-auth", () => ({
  completeEmailAuthMfa: (...args: any[]) => completeEmailAuthMfaMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-home",
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: async () => "https://home.example.test",
}));

jest.mock("./sign-in", () => ({
  signUserIn: (...args: any[]) => signUserInMock(...args),
}));

describe("/api/v2/auth/verify-second-factor", () => {
  beforeEach(() => {
    verifySignInSecondFactorChallengeMock.mockReset().mockResolvedValue({
      account_id: "22222222-2222-4222-8222-222222222222",
      email_auth_challenge_id: "11111111-1111-4111-8111-111111111111",
      factor_level: "totp",
      factor_verified_at: new Date(),
      primary_auth_method: "email_code",
      primary_verified_at: new Date(),
    });
    completeEmailAuthMfaMock.mockReset();
    signUserInMock.mockReset();
  });

  it("does not sign in when authoritative email MFA completion fails", async () => {
    completeEmailAuthMfaMock.mockRejectedValue(
      new Error("This email sign-in challenge is invalid."),
    );
    const { req, res } = createMocks({
      method: "POST",
      body: {
        challenge_id: "mfa-challenge",
        method: "totp",
        code: "123456",
      },
    });
    const { default: handler } = await import("./verify-second-factor");

    await handler(req, res);

    expect(completeEmailAuthMfaMock).toHaveBeenCalledWith({
      account_id: "22222222-2222-4222-8222-222222222222",
      challenge_id: "11111111-1111-4111-8111-111111111111",
      home_bay_id: "bay-home",
    });
    expect(signUserInMock).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({
      error: "This email sign-in challenge is invalid.",
      home_bay_id: "bay-home",
    });
  });
});
