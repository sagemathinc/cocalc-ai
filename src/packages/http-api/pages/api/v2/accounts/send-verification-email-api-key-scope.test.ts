/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockSendEmailVerification = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/accounts/send-email-verification", () => ({
  __esModule: true,
  default: (...args) => mockSendEmailVerification(...args),
}));

describe("/api/v2/accounts/send-verification-email API-key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockSendEmailVerification.mockReset().mockResolvedValue("");
  });

  it("rejects API-key verification email requests before account resolution", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "content-type": "application/json",
      },
      body: { email_address: "user@example.com" },
    });

    const { default: handler } = await import("./send-verification-email");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to send verification email",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockSendEmailVerification).not.toHaveBeenCalled();
  });

  it("keeps browser-session verification email requests", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { email_address: "user@example.com" },
    });

    const { default: handler } = await import("./send-verification-email");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockSendEmailVerification).toHaveBeenCalledWith("acct-1");
  });
});
