/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockSignInCheck = jest.fn();
const mockGetRequiresToken = jest.fn();
const mockGetClusterAccountByEmail = jest.fn();

jest.mock("@cocalc/server/auth/throttle", () => ({
  signInCheck: (...args) => mockSignInCheck(...args),
  recordFail: jest.fn(),
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
    mockGetRequiresToken.mockReset().mockResolvedValue(false);
    mockGetClusterAccountByEmail.mockReset().mockResolvedValue(undefined);
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
});
