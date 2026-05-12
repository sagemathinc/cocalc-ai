/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetServerSettings = jest.fn();
const mockIsAccountAvailable = jest.fn();
const mockReCaptcha = jest.fn();
const mockGetAccountId = jest.fn();
const mockIsDomainExclusiveSSO = jest.fn();
const mockRedeemRegistrationToken = jest.fn();
const mockCreateClusterAccount = jest.fn();
const mockSignUserIn = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/server/auth/is-account-available", () => ({
  __esModule: true,
  default: (...args) => mockIsAccountAvailable(...args),
}));

jest.mock("@cocalc/server/auth/is-domain-exclusive-sso", () => ({
  __esModule: true,
  default: (...args) => mockIsDomainExclusiveSSO(...args),
}));

jest.mock("@cocalc/server/auth/recaptcha", () => ({
  __esModule: true,
  default: (...args) => mockReCaptcha(...args),
}));

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/tokens/redeem", () => ({
  __esModule: true,
  default: (...args) => mockRedeemRegistrationToken(...args),
  disableRegistrationToken: jest.fn(),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  createClusterAccount: (...args) => mockCreateClusterAccount(...args),
}));

jest.mock("./sign-in", () => ({
  signUserIn: (...args) => mockSignUserIn(...args),
}));

jest.mock("@cocalc/server/software-licenses/activation", () => ({
  isLaunchpadMode: () => false,
  isSoftwareLicenseActivated: jest.fn(),
}));

jest.mock("@cocalc/server/auth/throttle", () => ({
  recordSignUpTokenFail: jest.fn(),
  signUpTokenCheck: jest.fn(),
}));

jest.mock("@cocalc/server/accounts/select-home-bay", () => ({
  selectSignupHomeBay: jest.fn().mockResolvedValue("bay-0"),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: jest
    .fn()
    .mockResolvedValue("https://bay-0.example.test"),
}));

jest.mock("@cocalc/server/email/welcome-email", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: jest.fn(),
  }),
}));

describe("/api/v2/auth/sign-up", () => {
  beforeEach(() => {
    mockGetServerSettings.mockReset().mockResolvedValue({
      email_signup: true,
    });
    mockIsAccountAvailable.mockReset().mockResolvedValue(true);
    mockReCaptcha.mockReset().mockResolvedValue(null);
    mockGetAccountId.mockReset().mockResolvedValue(undefined);
    mockIsDomainExclusiveSSO.mockReset().mockResolvedValue(undefined);
    mockRedeemRegistrationToken.mockReset().mockResolvedValue(undefined);
    mockCreateClusterAccount.mockReset();
    mockSignUserIn.mockReset();
  });

  it("does not sign in an existing account from the sign-up endpoint", async () => {
    mockIsAccountAvailable.mockResolvedValue(false);
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "existing@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "Existing",
        lastName: "User",
        registrationToken: "valid-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        email: 'Email address "existing@example.com" already in use.',
      },
    });
    expect(mockSignUserIn).not.toHaveBeenCalled();
    expect(mockRedeemRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });
});
