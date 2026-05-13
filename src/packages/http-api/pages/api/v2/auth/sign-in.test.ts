/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockSignInCheck = jest.fn();
const mockRecordFail = jest.fn();
const mockGetRequiresToken = jest.fn();
const mockGetClusterAccountByEmail = jest.fn();
const mockVerifyClusterAccountSignInPassword = jest.fn();
const mockHasActiveSecondFactor = jest.fn();
const mockCreateSignInSecondFactorChallenge = jest.fn();
const mockEmailRequiresCocalc2fa = jest.fn();

jest.mock("@cocalc/server/auth/throttle", () => ({
  signInCheck: (...args) => mockSignInCheck(...args),
  recordFail: (...args) => mockRecordFail(...args),
}));

jest.mock("@cocalc/server/auth/tokens/get-requires-token", () => ({
  __esModule: true,
  default: (...args) => mockGetRequiresToken(...args),
}));

jest.mock("@cocalc/server/auth/set-sign-in-cookies", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/auth/clear-auth-cookies", () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: jest.fn(),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountByEmail: (...args) => mockGetClusterAccountByEmail(...args),
  verifyClusterAccountSignInPassword: (...args) =>
    mockVerifyClusterAccountSignInPassword(...args),
}));

jest.mock("@cocalc/server/auth/two-factor", () => ({
  hasActiveSecondFactor: (...args) => mockHasActiveSecondFactor(...args),
  createSignInSecondFactorChallenge: (...args) =>
    mockCreateSignInSecondFactorChallenge(...args),
}));

jest.mock("@cocalc/database/settings/sso-policies", () => ({
  ...jest.requireActual("@cocalc/database/settings/sso-policies"),
  emailRequiresCocalc2fa: (...args) => mockEmailRequiresCocalc2fa(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: jest.fn(),
  }),
}));

describe("/api/v2/auth/sign-in", () => {
  beforeEach(() => {
    mockSignInCheck.mockReset().mockResolvedValue(undefined);
    mockRecordFail.mockReset();
    mockGetRequiresToken.mockReset().mockResolvedValue(false);
    mockGetClusterAccountByEmail.mockReset().mockResolvedValue(undefined);
    mockVerifyClusterAccountSignInPassword.mockReset().mockResolvedValue({
      account_id: "11111111-1111-1111-1111-111111111111",
      home_bay_id: "bay-1",
    });
    mockHasActiveSecondFactor.mockReset().mockResolvedValue(false);
    mockCreateSignInSecondFactorChallenge.mockReset().mockResolvedValue({
      challenge_id: "challenge-1",
      methods: ["totp", "recovery_code"],
    });
    mockEmailRequiresCocalc2fa.mockReset().mockResolvedValue(false);
  });

  it("returns a normal auth error when email and password are missing", async () => {
    const { req, res } = createMocks({
      method: "GET",
      url: "/api/v2/auth/sign-in",
    });

    const { default: handler } = await import("./sign-in");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error: "Problem signing into account.",
    });
    expect(mockSignInCheck).not.toHaveBeenCalled();
  });

  it("uses the generic invalid-credentials message on token-gated deployments", async () => {
    mockGetRequiresToken.mockResolvedValue(true);
    const { req, res } = createMocks({
      method: "GET",
      url: "/api/v2/auth/sign-in",
    });

    const { default: handler } = await import("./sign-in");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error: "Invalid email address or password.",
    });
  });

  it("returns an MFA challenge when the account has an active second factor", async () => {
    jest.resetModules();
    mockHasActiveSecondFactor.mockResolvedValue(true);
    jest.doMock("@cocalc/backend/auth/password-hash", () => ({
      verifyPassword: jest.fn().mockReturnValue(true),
    }));
    jest.doMock("@cocalc/server/bay-public-origin", () => ({
      getBayPublicOriginForRequest: jest
        .fn()
        .mockResolvedValue("https://bay-0.example.test"),
    }));
    jest.doMock("@cocalc/database/pool", () => ({
      __esModule: true,
      default: () => ({
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              account_id: "11111111-1111-1111-1111-111111111111",
              password_hash:
                "sha512$1000$12345678901234567890123456789012$sh6uWxxW8qfN5OeWs5IWmIh0L8mMxd0bqFGzJvqOK6NhQeR9CPGK8HBXHiY/VuxwxLBzME2YkdE+5EYXPLkZXA==",
              banned: false,
            },
          ],
        }),
      }),
    }));
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in",
      body: {
        email: "user@example.com",
        password: "correct horse battery staple",
      },
    });
    const { default: handler } = await import("./sign-in");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      mfa_required: true,
      challenge_id: "challenge-1",
      methods: ["totp", "recovery_code"],
      home_bay_id: "bay-0",
      home_bay_url: "https://bay-0.example.test",
    });
  });

  it("returns a clear error when too many recent MFA attempts block challenge creation", async () => {
    jest.resetModules();
    mockHasActiveSecondFactor.mockResolvedValue(true);
    mockCreateSignInSecondFactorChallenge.mockRejectedValue(
      new Error("too many recent second factor attempts"),
    );
    jest.doMock("@cocalc/backend/auth/password-hash", () => ({
      verifyPassword: jest.fn().mockReturnValue(true),
    }));
    jest.doMock("@cocalc/database/pool", () => ({
      __esModule: true,
      default: () => ({
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              account_id: "11111111-1111-1111-1111-111111111111",
              password_hash:
                "sha512$1000$12345678901234567890123456789012$sh6uWxxW8qfN5OeWs5IWmIh0L8mMxd0bqFGzJvqOK6NhQeR9CPGK8HBXHiY/VuxwxLBzME2YkdE+5EYXPLkZXA==",
              banned: false,
            },
          ],
        }),
      }),
    }));
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in",
      body: {
        email: "user@example.com",
        password: "correct horse battery staple",
      },
    });
    const { default: handler } = await import("./sign-in");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error:
        "Too many recent second factor attempts. Wait about an hour, then try again.",
    });
  });

  it("denies sign-in for a 2FA-required domain when the account has no second factor", async () => {
    jest.resetModules();
    mockEmailRequiresCocalc2fa.mockResolvedValue(true);
    jest.doMock("@cocalc/backend/auth/password-hash", () => ({
      verifyPassword: jest.fn().mockReturnValue(true),
    }));
    jest.doMock("@cocalc/database/pool", () => ({
      __esModule: true,
      default: () => ({
        query: jest.fn().mockResolvedValue({
          rows: [
            {
              account_id: "11111111-1111-1111-1111-111111111111",
              password_hash:
                "sha512$1000$12345678901234567890123456789012$sh6uWxxW8qfN5OeWs5IWmIh0L8mMxd0bqFGzJvqOK6NhQeR9CPGK8HBXHiY/VuxwxLBzME2YkdE+5EYXPLkZXA==",
              banned: false,
            },
          ],
        }),
      }),
    }));
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in",
      body: {
        email: "user@example.com",
        password: "correct horse battery staple",
      },
    });
    const { default: handler } = await import("./sign-in");
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error:
        "This email domain requires CoCalc two-factor authentication. Contact your site administrator to enable 2FA before signing in.",
    });
  });

  it("does not return wrong-bay routing before the home bay verifies the password", async () => {
    mockGetClusterAccountByEmail.mockResolvedValue({
      account_id: "11111111-1111-1111-1111-111111111111",
      email_address: "user@example.com",
      home_bay_id: "bay-1",
    });
    mockVerifyClusterAccountSignInPassword.mockRejectedValue(
      new Error("password for 'user@example.com' is incorrect"),
    );

    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in",
      body: {
        email: "user@example.com",
        password: "wrong password",
      },
    });
    const { default: handler } = await import("./sign-in");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error: "Invalid email address or password.",
    });
    expect(mockVerifyClusterAccountSignInPassword).toHaveBeenCalledWith({
      home_bay_id: "bay-1",
      email_address: "user@example.com",
      password: "wrong password",
    });
    expect(mockRecordFail).toHaveBeenCalledWith("user@example.com", req.ip);
  });
});
