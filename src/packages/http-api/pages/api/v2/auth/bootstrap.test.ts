/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetClusterAccountById = jest.fn();
const mockGetBayPublicOriginForRequest = jest.fn();
const mockGetImpersonationBootstrapInfo = jest.fn();
const mockListAccountProjectWindow = jest.fn();
const mockGetConfiguredBayId = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  getClusterAccountById: (...args) => mockGetClusterAccountById(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => mockGetConfiguredBayId(),
}));

jest.mock("@cocalc/server/projects/list-account-window", () => ({
  listAccountProjectWindow: (...args) => mockListAccountProjectWindow(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  getBayPublicOriginForRequest: (...args) =>
    mockGetBayPublicOriginForRequest(...args),
}));

jest.mock("@cocalc/server/auth/impersonation", () => ({
  getImpersonationBootstrapInfo: (...args) =>
    mockGetImpersonationBootstrapInfo(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args) => mockPoolQuery(...args) }),
}));

jest.mock("@cocalc/backend/base-path", () => ({
  __esModule: true,
  default: "/tenant",
}));

describe("/api/v2/auth/bootstrap", () => {
  beforeEach(() => {
    mockGetAccountId.mockReset();
    mockGetClusterAccountById.mockReset();
    mockGetBayPublicOriginForRequest
      .mockReset()
      .mockResolvedValue("https://bay-0.example.test");
    mockGetImpersonationBootstrapInfo.mockReset().mockResolvedValue(null);
    mockGetConfiguredBayId.mockReset().mockReturnValue("bay-0");
    mockListAccountProjectWindow.mockReset().mockResolvedValue([]);
    mockPoolQuery.mockReset().mockResolvedValue({
      rows: [{ editor_settings: { jupyter_line_numbers: true } }],
    });
  });

  it("uses display_name instead of stale legacy split names", async () => {
    mockGetAccountId.mockResolvedValue("account-1");
    mockGetClusterAccountById.mockResolvedValue({
      account_id: "account-1",
      display_name: "AdmiN",
      email_address: "admin@example.com",
      email_address_verified: true,
      first_name: "Admin",
      home_bay_id: "bay-0",
      last_name: "User",
    });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/bootstrap",
    });

    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);

    expect(res._getJSONData()).toEqual(
      expect.objectContaining({
        account_id: "account-1",
        display_name: "AdmiN",
        email_address: "admin@example.com",
        email_address_verified: true,
        jupyter_line_numbers: true,
        signed_in: true,
        client_capabilities: {
          protocol_version: 1,
          app_base_path: "/tenant",
          browser_challenge_login: 1,
          project_window: 1,
          project_host_routing: 1,
          chat_sync: 2,
          agent_session_index: 1,
          acp: 1,
        },
      }),
    );
  });

  it("advertises the same protocol before sign-in", async () => {
    mockGetAccountId.mockResolvedValue(undefined);
    const { req, res } = createMocks({
      method: "POST",
      url: "/tenant/api/v2/auth/bootstrap",
    });

    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);

    expect(res._getJSONData()).toEqual(
      expect.objectContaining({
        signed_in: false,
        client_capabilities: expect.objectContaining({
          protocol_version: 1,
          app_base_path: "/tenant",
          browser_challenge_login: 1,
        }),
      }),
    );
  });

  it.each([
    [undefined, "light"],
    [{ dark_mode: true }, "dark"],
    [{ dark_mode: true, appearance_theme: "system" }, "system"],
  ])(
    "returns authoritative appearance without exposing other account settings",
    async (other_settings, appearance_theme) => {
      mockGetAccountId.mockResolvedValue("account-1");
      mockGetClusterAccountById.mockResolvedValue({ home_bay_id: "bay-0" });
      mockPoolQuery.mockResolvedValue({ rows: [{ other_settings }] });
      const { req, res } = createMocks({
        method: "POST",
        url: "/api/v2/auth/bootstrap",
      });
      const { default: bootstrap } = await import("./bootstrap");
      await bootstrap(req, res);
      expect(res._getJSONData().appearance_theme).toBe(appearance_theme);
      expect(res._getJSONData()).not.toHaveProperty("other_settings");
    },
  );

  it("does not infer account appearance from a non-authoritative bay", async () => {
    mockGetAccountId.mockResolvedValue("account-1");
    mockGetClusterAccountById.mockResolvedValue({ home_bay_id: "bay-2" });
    const { req, res } = createMocks({
      method: "POST",
      url: "/api/v2/auth/bootstrap",
    });
    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(res._getJSONData()).not.toHaveProperty("appearance_theme");
  });

  it("includes a bounded project window on the authoritative home bay", async () => {
    mockGetAccountId.mockResolvedValue("account-1");
    mockGetClusterAccountById.mockResolvedValue({
      account_id: "account-1",
      home_bay_id: "bay-0",
    });
    mockListAccountProjectWindow.mockResolvedValue([
      { project_id: "project-1", title: "One" },
      { project_id: "project-2", title: "Two" },
      { project_id: "project-3", title: "Three" },
    ]);
    const { req, res } = createMocks({
      body: { project_window: { limit: 2, offset: 4, search: " test " } },
      method: "POST",
      url: "/api/v2/auth/bootstrap",
    });

    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);

    expect(mockListAccountProjectWindow).toHaveBeenCalledWith({
      account_id: "account-1",
      hidden: false,
      limit: 3,
      offset: 4,
      project_id: undefined,
      search: "test",
      sort: "last_edited",
    });
    expect(res._getJSONData()).toEqual(
      expect.objectContaining({
        project_window: [
          { project_id: "project-1", title: "One" },
          { project_id: "project-2", title: "Two" },
        ],
        project_window_has_more: true,
      }),
    );
  });

  it("does not read the project projection on a non-authoritative bay", async () => {
    mockGetAccountId.mockResolvedValue("account-1");
    mockGetClusterAccountById.mockResolvedValue({
      account_id: "account-1",
      home_bay_id: "bay-2",
    });
    const { req, res } = createMocks({
      body: { project_window: { limit: 50 } },
      method: "POST",
      url: "/api/v2/auth/bootstrap",
    });

    const { default: bootstrap } = await import("./bootstrap");
    await bootstrap(req, res);

    expect(mockListAccountProjectWindow).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual(
      expect.not.objectContaining({ project_window: expect.anything() }),
    );
  });
});
