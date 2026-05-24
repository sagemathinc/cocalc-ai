/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockSetProject = jest.fn();
const mockUserIsInGroup = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/projects/set-one", () => ({
  __esModule: true,
  default: (...args) => mockSetProject(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

describe("/api/v2/projects/update API-key scope", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:write"],
      allowed_project_ids: [project_id],
    });
    mockSetProject.mockReset().mockResolvedValue(undefined);
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
  });

  it("rejects API keys without project write capability for the project", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { project_id, title: "Renamed" },
    });

    const { default: handler } = await import("./update");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'project:write' for project ${project_id}`,
    });
    expect(mockSetProject).not.toHaveBeenCalled();
  });

  it("allows API keys with project write capability for the project", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { project_id, title: "Renamed" },
    });

    const { default: handler } = await import("./update");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockSetProject).toHaveBeenCalledWith({
      acting_account_id: "acct-1",
      project_id,
      project_update: {
        title: "Renamed",
        description: undefined,
        name: undefined,
      },
    });
  });

  it("does not let API keys use the admin account_id override", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: {
        account_id: "22222222-2222-4222-8222-222222222222",
        project_id,
        title: "Renamed",
      },
    });

    const { default: handler } = await import("./update");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "The `account_id` field cannot be specified by API keys.",
    });
    expect(mockSetProject).not.toHaveBeenCalled();
  });
});
