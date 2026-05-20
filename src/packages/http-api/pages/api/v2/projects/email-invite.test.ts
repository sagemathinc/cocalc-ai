/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockPreviewEmailProjectInvite = jest.fn();
const mockRedeemEmailProjectInvite = jest.fn();
const mockRespondEmailProjectInvite = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  __esModule: true,
  previewEmailProjectInvite: (...args) =>
    mockPreviewEmailProjectInvite(...args),
  redeemEmailProjectInvite: (...args) => mockRedeemEmailProjectInvite(...args),
  respondEmailProjectInvite: (...args) =>
    mockRespondEmailProjectInvite(...args),
}));

describe("/api/v2/projects email invite handlers", () => {
  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockPreviewEmailProjectInvite.mockReset().mockResolvedValue({
      invite_id: "invite-1",
    });
    mockRedeemEmailProjectInvite.mockReset().mockResolvedValue({
      invite_id: "invite-1",
    });
    mockRespondEmailProjectInvite.mockReset().mockResolvedValue({
      invite_id: "invite-1",
    });
  });

  it("previews token-only invite links through the central directory", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { token: "token-1" },
    });

    const { default: handler } = await import("./preview-email-invite");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ invite: { invite_id: "invite-1" } });
    expect(mockPreviewEmailProjectInvite).toHaveBeenCalledWith({
      account_id: "acct-1",
      token: "token-1",
    });
  });

  it("responds to token-only invite links through the central directory", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { action: "accept", token: "token-1" },
    });

    const { default: handler } = await import("./respond-email-invite");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ invite: { invite_id: "invite-1" } });
    expect(mockRespondEmailProjectInvite).toHaveBeenCalledWith({
      account_id: "acct-1",
      action: "accept",
      token: "token-1",
    });
  });

  it("redeems token-only invite links through the central directory", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { token: "token-1" },
    });

    const { default: handler } = await import("./redeem-email-invite");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ invite: { invite_id: "invite-1" } });
    expect(mockRedeemEmailProjectInvite).toHaveBeenCalledWith({
      account_id: "acct-1",
      token: "token-1",
    });
  });
});
