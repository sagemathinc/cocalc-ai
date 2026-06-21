/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetSupportTickets = jest.fn();
const mockCreateSupportTicket = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/support/get-tickets", () => ({
  __esModule: true,
  default: (...args) => mockGetSupportTickets(...args),
}));

jest.mock("@cocalc/server/support/create-ticket", () => ({
  __esModule: true,
  default: (...args) => mockCreateSupportTicket(...args),
}));

describe("/api/v2/support API-key scope", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetSupportTickets.mockReset().mockResolvedValue([
      {
        id: 123,
        subject: "Private support issue",
        description: "contains private context",
      },
    ]);
    mockCreateSupportTicket
      .mockReset()
      .mockResolvedValue("https://support.example.com/tickets/123");
  });

  it("rejects API-key access to support ticket history", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });

    const { default: handler } = await import("./support/tickets");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to access support tickets",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockGetSupportTickets).not.toHaveBeenCalled();
  });

  it("keeps browser-session support ticket history access", async () => {
    const { req, res } = createMocks({ method: "POST", body: {} });

    const { default: handler } = await import("./support/tickets");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      tickets: [
        {
          id: 123,
          subject: "Private support issue",
          description: "contains private context",
        },
      ],
    });
    expect(mockGetSupportTickets).toHaveBeenCalledWith("acct-1");
  });

  it("rejects API-key support ticket creation", async () => {
    const options = {
      email: "user@example.com",
      subject: "Private support issue",
      body: "This is private support context.",
    };
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { options },
    });

    const { default: handler } = await import("./support/create-ticket");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to create support tickets",
    });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockCreateSupportTicket).not.toHaveBeenCalled();
  });

  it("rejects non-POST support ticket creation before account lookup", async () => {
    const { req, res } = createMocks({
      method: "GET",
      body: {
        options: {
          email: "user@example.com",
          subject: "Private support issue",
          body: "This is private support context.",
        },
      },
    });

    const { default: handler } = await import("./support/create-ticket");
    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.getHeader("Allow")).toBe("POST");
    expect(res._getJSONData()).toEqual({ error: "method_not_allowed" });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockCreateSupportTicket).not.toHaveBeenCalled();
  });

  it("keeps browser-session support ticket creation", async () => {
    const options = {
      email: "user@example.com",
      subject: "Private support issue",
      body: "This is private support context.",
    };
    const { req, res } = createMocks({
      method: "POST",
      body: { options },
    });

    const { default: handler } = await import("./support/create-ticket");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      url: "https://support.example.com/tickets/123",
    });
    expect(mockCreateSupportTicket).toHaveBeenCalledWith({
      ...options,
      account_id: "acct-1",
      ip_address: req.ip ?? req.socket?.remoteAddress,
    });
  });
});
