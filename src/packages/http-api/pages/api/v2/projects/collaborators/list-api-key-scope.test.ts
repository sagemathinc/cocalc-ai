/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockUserIsInGroup = jest.fn();
const mockGetCollaborators = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

jest.mock("@cocalc/http-api/lib/share/get-collaborators", () => ({
  __esModule: true,
  default: (...args) => mockGetCollaborators(...args),
}));

describe("/api/v2/projects/collaborators/list API-key scope", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";
  const collaborators = [
    {
      account_id: "22222222-2222-4222-8222-222222222222",
      first_name: "Ada",
      last_name: "Lovelace",
    },
  ];

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:read"],
      allowed_project_ids: [project_id],
    });
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
    mockGetCollaborators.mockReset().mockResolvedValue(collaborators);
  });

  it("requires project read capability for API-key collaborator listing", async () => {
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
      body: { project_id },
    });

    const { default: handler } = await import("./list");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'project:read' for project ${project_id}`,
    });
    expect(mockGetCollaborators).not.toHaveBeenCalled();
  });

  it("allows API-key collaborator listing with project read capability and allowlist", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { project_id },
    });

    const { default: handler } = await import("./list");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(collaborators);
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockGetCollaborators).toHaveBeenCalledWith(project_id, "acct-1");
  });

  it("keeps browser-session collaborator listing behavior", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { project_id },
    });

    const { default: handler } = await import("./list");
    await handler(req, res);

    expect(res._getJSONData()).toEqual(collaborators);
    expect(mockUserIsInGroup).toHaveBeenCalledWith("acct-1", "admin");
    expect(mockGetCollaborators).toHaveBeenCalledWith(project_id, "acct-1");
  });
});
