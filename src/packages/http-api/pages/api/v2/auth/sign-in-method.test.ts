/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetStrategies = jest.fn();

jest.mock("@cocalc/database/settings/get-sso-strategies", () => ({
  __esModule: true,
  default: (...args) => mockGetStrategies(...args),
}));

describe("/api/v2/auth/sign-in-method", () => {
  beforeEach(() => {
    mockGetStrategies.mockReset().mockResolvedValue([
      {
        name: "cornell",
        display: "Cornell SSO",
        backgroundColor: "",
        public: false,
        exclusiveDomains: ["cornell.edu"],
        doNotHide: false,
      },
      {
        name: "google",
        display: "Google",
        backgroundColor: "#dc4857",
        public: true,
        exclusiveDomains: [],
        doNotHide: false,
      },
    ]);
  });

  it("rejects invalid emails without reading SSO strategies", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in-method",
      body: {
        email: "not an email",
      },
    });

    const { default: handler } = await import("./sign-in-method");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      error: "Invalid email address.",
    });
    expect(mockGetStrategies).not.toHaveBeenCalled();
  });

  it("returns the required SSO strategy for an exclusive domain", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in-method",
      body: {
        email: "User@Sub.Cornell.edu",
      },
    });

    const { default: handler } = await import("./sign-in-method");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      email: "user@sub.cornell.edu",
      password_allowed: false,
      sso_required: true,
      sso_strategy: {
        name: "cornell",
        display: "Cornell SSO",
        backgroundColor: "",
        public: false,
        exclusiveDomains: ["cornell.edu"],
        doNotHide: false,
      },
      reason: "domain_sso_required",
    });
  });

  it("allows password sign-in when no domain SSO policy matches", async () => {
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/sign-in-method",
      body: {
        email: "user@example.com",
      },
    });

    const { default: handler } = await import("./sign-in-method");
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({
      email: "user@example.com",
      password_allowed: true,
      sso_required: false,
    });
  });
});
