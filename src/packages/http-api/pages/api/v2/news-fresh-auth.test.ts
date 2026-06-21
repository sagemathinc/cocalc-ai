/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetParams = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockGetCurrentAuthSession = jest.fn();
const mockRequireDangerousSessionAuth = jest.fn();
const mockEditNews = jest.fn();
const mockClearNewsCache = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/http-api/lib/api/get-params", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetParams(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  getCurrentAuthSession: (...args: any[]) => mockGetCurrentAuthSession(...args),
}));

jest.mock("@cocalc/server/conat/api/dangerous-session-auth", () => ({
  requireDangerousSessionAuth: (...args: any[]) =>
    mockRequireDangerousSessionAuth(...args),
}));

jest.mock("@cocalc/server/news/edit", () => ({
  __esModule: true,
  default: (...args: any[]) => mockEditNews(...args),
}));

jest.mock("@cocalc/database/postgres/news", () => ({
  clearCache: (...args: any[]) => mockClearNewsCache(...args),
}));

describe("news edit fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("admin-1");
    mockGetParams.mockReset().mockReturnValue({
      channel: "feature",
      id: 7,
      text: "Body",
      title: "Title",
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockGetCurrentAuthSession.mockReset().mockResolvedValue({
      session_hash: "fresh-session-hash",
    });
    mockRequireDangerousSessionAuth.mockReset().mockResolvedValue(undefined);
    mockEditNews.mockReset().mockResolvedValue({ id: 7 });
    mockClearNewsCache.mockReset();
  });

  it("rejects non-POST news edits before auth lookup", async () => {
    const { req, res } = createMocks({ method: "GET" });

    const { default: handler } = await import("./news/edit");
    await handler(req, res);

    expect(res.statusCode).toBe(405);
    expect(res.getHeader("Allow")).toBe("POST");
    expect(res._getJSONData()).toEqual({ error: "method_not_allowed" });
    expect(mockGetAccountId).not.toHaveBeenCalled();
    expect(mockEditNews).not.toHaveBeenCalled();
  });

  it("requires direct dangerous auth before editing news", async () => {
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "two_factor_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./news/edit");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "recent two-factor verification is required",
    });
    expect(mockGetCurrentAuthSession).toHaveBeenCalledWith({
      req,
      account_id: "admin-1",
    });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockEditNews).not.toHaveBeenCalled();
    expect(mockClearNewsCache).not.toHaveBeenCalled();
  });

  it("edits news after direct dangerous auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./news/edit");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ id: 7, success: true });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockEditNews).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        text: "Body",
        title: "Title",
      }),
    );
    expect(mockClearNewsCache).toHaveBeenCalled();
  });
});
