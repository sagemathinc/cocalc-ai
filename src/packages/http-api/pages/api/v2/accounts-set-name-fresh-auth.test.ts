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
const mockUserQuery = jest.fn();

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

jest.mock("@cocalc/database/user-query", () => ({
  __esModule: true,
  default: (...args: any[]) => mockUserQuery(...args),
}));

describe("account set-name fresh auth", () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("admin-1");
    mockGetParams.mockReset().mockReturnValue({
      account_id: "user-1",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(true);
    mockGetCurrentAuthSession.mockReset().mockResolvedValue({
      session_hash: "fresh-session-hash",
    });
    mockRequireDangerousSessionAuth.mockReset().mockResolvedValue(undefined);
    mockUserQuery.mockReset().mockResolvedValue(undefined);
  });

  it("requires direct dangerous auth before admin edits another account name", async () => {
    mockRequireDangerousSessionAuth.mockRejectedValue(
      Object.assign(new Error("recent two-factor verification is required"), {
        code: "two_factor_required",
      }),
    );
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-name");
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
    expect(mockUserQuery).not.toHaveBeenCalled();
  });

  it("does not require dangerous auth for self name edits", async () => {
    mockGetParams.mockReturnValue({
      username: "legacy-name",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-name");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockRequireDangerousSessionAuth).not.toHaveBeenCalled();
    expect(mockUserQuery).toHaveBeenCalledWith({
      account_id: "admin-1",
      query: {
        accounts: {
          display_name: "Ada Lovelace",
        },
      },
    });
  });

  it("updates another account name after direct dangerous auth", async () => {
    const { req, res } = createMocks({ method: "POST" });

    const { default: handler } = await import("./accounts/set-name");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "success" });
    expect(mockRequireDangerousSessionAuth).toHaveBeenCalledWith({
      account_id: "admin-1",
      session_hash: "fresh-session-hash",
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
    expect(mockUserQuery).toHaveBeenCalledWith({
      account_id: "user-1",
      query: {
        accounts: {
          display_name: "Ada Lovelace",
        },
      },
    });
  });
});
