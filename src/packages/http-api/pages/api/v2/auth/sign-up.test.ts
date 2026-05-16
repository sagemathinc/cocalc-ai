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
const mockRedeemRegistrationToken = jest.fn();
const mockValidateRegistrationToken = jest.fn();
const mockDeleteRegistrationToken = jest.fn();
const mockGetRequiresRegistrationToken = jest.fn();
const mockCreateClusterAccount = jest.fn();
const mockSignUserIn = jest.fn();
const mockSendEmailVerification = jest.fn();
const mockRecordSignUpTokenFail = jest.fn();
const mockSignUpTokenCheck = jest.fn();
const mockGetEnabledSsoDomainPolicyForEmail = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: (...args) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/server/auth/is-account-available", () => ({
  __esModule: true,
  default: (...args) => mockIsAccountAvailable(...args),
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
  validateRegistrationToken: (...args) =>
    mockValidateRegistrationToken(...args),
  deleteRegistrationToken: (...args) => mockDeleteRegistrationToken(...args),
}));

jest.mock("@cocalc/server/auth/tokens/get-requires-token", () => ({
  __esModule: true,
  default: (...args) => mockGetRequiresRegistrationToken(...args),
}));

jest.mock("@cocalc/database/settings/sso-policies", () => ({
  getEnabledSsoDomainPolicyForEmail: (...args) =>
    mockGetEnabledSsoDomainPolicyForEmail(...args),
  passwordSignupBlockedBySsoPolicy: (policy) =>
    policy?.mode === "sso_required" || policy?.mode === "sso_signup_only",
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
  recordSignUpTokenFail: (...args) => mockRecordSignUpTokenFail(...args),
  signUpTokenCheck: (...args) => mockSignUpTokenCheck(...args),
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

jest.mock("@cocalc/server/accounts/send-email-verification", () => ({
  __esModule: true,
  default: (...args) => mockSendEmailVerification(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: (...args) => mockPoolQuery(...args),
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
    mockGetRequiresRegistrationToken.mockReset().mockResolvedValue(true);
    mockValidateRegistrationToken.mockReset().mockResolvedValue({});
    mockDeleteRegistrationToken.mockReset().mockResolvedValue(undefined);
    mockRedeemRegistrationToken.mockReset().mockResolvedValue(undefined);
    mockCreateClusterAccount.mockReset();
    mockSignUserIn.mockReset();
    mockSendEmailVerification.mockReset().mockResolvedValue("");
    mockRecordSignUpTokenFail.mockReset();
    mockSignUpTokenCheck.mockReset().mockReturnValue(undefined);
    mockGetEnabledSsoDomainPolicyForEmail
      .mockReset()
      .mockResolvedValue(undefined);
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
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
    expect(mockValidateRegistrationToken).toHaveBeenCalledWith("valid-token");
    expect(mockSignUserIn).not.toHaveBeenCalled();
    expect(mockRedeemRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("validates a required registration token before checking account availability", async () => {
    mockValidateRegistrationToken.mockRejectedValue(
      new Error("Registration token is wrong."),
    );
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "existing@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "Existing",
        lastName: "User",
        registrationToken: "wrong-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        registrationToken:
          "Issue with registration token -- Registration token is wrong.",
      },
    });
    expect(mockSignUpTokenCheck).toHaveBeenCalledWith(
      "existing@example.com",
      req.ip,
    );
    expect(mockRecordSignUpTokenFail).toHaveBeenCalledWith(
      "existing@example.com",
      req.ip,
    );
    expect(mockIsAccountAvailable).not.toHaveBeenCalled();
    expect(mockRedeemRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("pre-throttles required registration token attempts even when token is missing", async () => {
    mockSignUpTokenCheck.mockReturnValue("too many token attempts");
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        registrationToken: "too many token attempts",
      },
    });
    expect(mockValidateRegistrationToken).not.toHaveBeenCalled();
    expect(mockIsAccountAvailable).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("blocks password signup when a domain policy disables account creation", async () => {
    mockGetEnabledSsoDomainPolicyForEmail.mockResolvedValue({
      domain: "example.com",
      provider_id: "google",
      mode: "password_allowed",
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "disabled",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        email: 'Account creation is disabled for "@example.com".',
      },
    });
    expect(mockValidateRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("blocks password signup when a domain policy requires SSO", async () => {
    mockGetEnabledSsoDomainPolicyForEmail.mockResolvedValue({
      domain: "example.com",
      provider_id: "google",
      mode: "sso_required",
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "inherit",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        email:
          'To sign up with "@example.com", you have to use the corresponding single sign on mechanism.  Delete your email address above, then click the SSO icon.',
      },
    });
    expect(mockValidateRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("allows domain policy to require a token even when global public signup is enabled", async () => {
    mockGetRequiresRegistrationToken.mockResolvedValue(false);
    mockValidateRegistrationToken.mockRejectedValue(
      new Error("no registration token provided"),
    );
    mockGetEnabledSsoDomainPolicyForEmail.mockResolvedValue({
      domain: "example.com",
      provider_id: "google",
      mode: "password_allowed",
      enabled: true,
      require_cocalc_2fa: false,
      signup_mode: "registration_token_required",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        registrationToken:
          "Issue with registration token -- no registration token provided",
      },
    });
    expect(mockValidateRegistrationToken).toHaveBeenCalledWith("");
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("does not create new password accounts for domains requiring CoCalc 2FA", async () => {
    mockGetEnabledSsoDomainPolicyForEmail.mockResolvedValue({
      domain: "example.com",
      provider_id: "google",
      mode: "password_allowed",
      enabled: true,
      require_cocalc_2fa: true,
      signup_mode: "public_allowed",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        email:
          'Account creation is disabled for "@example.com" because that domain requires CoCalc two-factor authentication. Contact your site administrator to create or prepare your account.',
      },
    });
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("does not consume a valid registration token when the email is unavailable", async () => {
    mockIsAccountAvailable.mockResolvedValue(false);
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "taken@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "Taken",
        lastName: "User",
        registrationToken: "valid-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        email: 'Email address "taken@example.com" already in use.',
      },
    });
    expect(mockValidateRegistrationToken).toHaveBeenCalledWith("valid-token");
    expect(mockRedeemRegistrationToken).not.toHaveBeenCalled();
    expect(mockCreateClusterAccount).not.toHaveBeenCalled();
  });

  it("returns a generic error if account creation fails", async () => {
    mockRedeemRegistrationToken.mockResolvedValue({});
    mockCreateClusterAccount.mockRejectedValue(new Error("secret db detail"));
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
        registrationToken: "valid-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      issues: {
        api: "Problem creating account. Please try again.",
      },
    });
  });

  it("deletes a bootstrap registration token after successful use", async () => {
    mockRedeemRegistrationToken.mockResolvedValue({
      customize: { make_admin: true, bootstrap: true },
    });
    mockCreateClusterAccount.mockResolvedValue({
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      home_bay_id: "bay-0",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "admin@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "Admin",
        lastName: "User",
        registrationToken: "bootstrap-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(mockCreateClusterAccount).toHaveBeenCalled();
    expect(mockDeleteRegistrationToken).toHaveBeenCalledWith("bootstrap-token");
    expect(mockSignUserIn).toHaveBeenCalledWith(
      req,
      res,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });

  it("sends only a verification email for public password signup", async () => {
    mockGetRequiresRegistrationToken.mockResolvedValue(false);
    mockCreateClusterAccount.mockResolvedValue({
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      home_bay_id: "bay-0",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(mockCreateClusterAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        trusted_product_access: false,
        trusted_product_access_reason: undefined,
      }),
    );
    expect(mockSendEmailVerification).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      true,
    );
    expect(mockSignUserIn).toHaveBeenCalledWith(
      req,
      res,
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
  });

  it("sends the welcome email path for registration-token signup", async () => {
    mockRedeemRegistrationToken.mockResolvedValue({});
    mockCreateClusterAccount.mockResolvedValue({
      account_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      home_bay_id: "bay-0",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-up",
      body: {
        terms: true,
        email: "new@example.com",
        password: "correct horse battery staple 12345!",
        firstName: "New",
        lastName: "User",
        registrationToken: "valid-token",
      },
    });

    const { signUp } = await import("./sign-up");
    await signUp(req, res);

    expect(mockCreateClusterAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        trusted_product_access: true,
        trusted_product_access_reason: "registration_token",
      }),
    );
    expect(mockSendEmailVerification).toHaveBeenCalledWith(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      false,
    );
  });
});
