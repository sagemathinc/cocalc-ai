/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockGetRememberMeHashes = jest.fn();
const mockEndSignInSession = jest.fn();
const mockEndAllSignInSessions = jest.fn();
const mockRecordAccountRevocation = jest.fn();
const mockClearAuthCookies = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  getRememberMeHashes: (...args) => mockGetRememberMeHashes(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  endSignInSession: (...args) => mockEndSignInSession(...args),
  endAllSignInSessions: (...args) => mockEndAllSignInSessions(...args),
}));

jest.mock("@cocalc/server/accounts/revocation", () => ({
  recordAccountRevocation: (...args) => mockRecordAccountRevocation(...args),
}));

jest.mock("@cocalc/server/auth/clear-auth-cookies", () => ({
  __esModule: true,
  default: (...args) => mockClearAuthCookies(...args),
}));

describe("/api/v2/accounts/sign-out API-key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetParams.mockReset().mockReturnValue({ all: true });
    mockGetRememberMeHashes.mockReset().mockReturnValue(["hash-1"]);
    mockEndSignInSession.mockReset().mockResolvedValue(undefined);
    mockEndAllSignInSessions.mockReset().mockResolvedValue(undefined);
    mockRecordAccountRevocation.mockReset().mockResolvedValue(undefined);
    mockClearAuthCookies.mockReset().mockResolvedValue(undefined);
  });

  it("rejects API-key sign-out before revoking sessions", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: { all: true },
    });

    const { default: handler } = await import("./sign-out");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to sign out browser sessions",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockEndAllSignInSessions).not.toHaveBeenCalled();
    expect(mockRecordAccountRevocation).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).not.toHaveBeenCalled();
  });

  it("keeps browser-session sign-out-all behavior", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { all: true },
    });

    const { default: handler } = await import("./sign-out");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockEndAllSignInSessions).toHaveBeenCalledWith("acct-1");
    expect(mockRecordAccountRevocation).toHaveBeenCalledWith(
      "acct-1",
      expect.any(Number),
    );
    expect(mockClearAuthCookies).toHaveBeenCalledWith({ req, res });
  });

  it("ends each cookie's own session when signing out of this browser", async () => {
    mockGetParams.mockReturnValue({ all: false });
    mockGetRememberMeHashes.mockReturnValue(["hash-1", "hash-2"]);
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { all: false },
    });

    const { default: handler } = await import("./sign-out");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockEndSignInSession.mock.calls).toEqual([
      [{ session_hash: "hash-1" }],
      [{ session_hash: "hash-2" }],
    ]);
    expect(mockClearAuthCookies).toHaveBeenCalledWith({ req, res });
  });

  it("still clears this browser's cookies when the server refuses", async () => {
    mockEndAllSignInSessions.mockRejectedValue(
      new Error("account rehome is running"),
    );
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { all: true },
    });

    const { default: handler } = await import("./sign-out");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ error: "account rehome is running" });
    expect(mockRecordAccountRevocation).not.toHaveBeenCalled();
    expect(mockClearAuthCookies).toHaveBeenCalledWith({ req, res });
  });
});
