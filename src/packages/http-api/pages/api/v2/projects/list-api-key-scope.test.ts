/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockGetProjects = jest.fn();
const mockListProjectSummaries = jest.fn();
const mockCreateProject = jest.fn();
const mockUserIsInGroup = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/projects/get", () => ({
  __esModule: true,
  default: (...args) => mockGetProjects(...args),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  listProjectSummariesForApiKey: (principal, opts) =>
    mockListProjectSummaries({ ...opts, account_id: principal.account_id }),
}));

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: (...args) => mockCreateProject(...args),
}));

jest.mock("@cocalc/server/accounts/is-in-group", () => ({
  __esModule: true,
  default: (...args) => mockUserIsInGroup(...args),
}));

describe("/api/v2/projects list API-key scope", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue(account_id);
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id,
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:list"],
      allowed_project_ids: [],
    });
    mockGetProjects.mockReset().mockResolvedValue([
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Project",
      },
    ]);
    mockCreateProject
      .mockReset()
      .mockResolvedValue("33333333-3333-4333-8333-333333333333");
    mockUserIsInGroup.mockReset().mockResolvedValue(false);
    mockListProjectSummaries.mockReset().mockResolvedValue({
      projects: [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          title: "Project",
        },
      ],
      next_offset: null,
    });
  });

  it("requires project list capability for API-key project listing", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id,
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
      body: { limit: 10 },
    });

    const { default: handler } = await import("./get");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'project:list'",
    });
    expect(mockGetProjects).not.toHaveBeenCalled();
    expect(mockListProjectSummaries).not.toHaveBeenCalled();
  });

  it("does not allow API-key project listing for a different account", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: {
        account_id: "44444444-4444-4444-8444-444444444444",
        limit: 10,
      },
    });

    const { default: handler } = await import("./get");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API keys may only list projects for their own account",
    });
    expect(mockUserIsInGroup).not.toHaveBeenCalled();
    expect(mockGetProjects).not.toHaveBeenCalled();
    expect(mockListProjectSummaries).not.toHaveBeenCalled();
  });

  it("allows API-key project listing with project list capability", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { limit: 10 },
    });

    const { default: handler } = await import("./get");
    await handler(req, res);

    expect(res._getJSONData()).toEqual([
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Project",
      },
    ]);
    expect(mockListProjectSummaries).toHaveBeenCalledWith({
      account_id,
      limit: 10,
      offset: 0,
      search: undefined,
    });
    expect(mockGetProjects).not.toHaveBeenCalled();
  });

  it("requires project list capability for API-key get-one", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id,
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });

    const { default: handler } = await import("./get-one");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'project:list'",
    });
    expect(mockGetProjects).not.toHaveBeenCalled();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("get-one projects only legacy fields from the owner-routed summary", async () => {
    mockListProjectSummaries.mockResolvedValue({
      projects: [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          title: "Project",
          description: "Description",
          host_id: "host",
          state: "running",
          last_edited: null,
        },
      ],
      next_offset: 1,
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });
    const { default: handler } = await import("./get-one");
    await handler(req, res);
    expect(res._getJSONData()).toEqual({
      project_id: "22222222-2222-4222-8222-222222222222",
      title: "Project",
      description: "Description",
    });
    expect(mockListProjectSummaries).toHaveBeenCalledWith({
      account_id,
      limit: 1,
    });
    expect(mockGetProjects).not.toHaveBeenCalled();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("get-one does not create or fall back when account-home lookup fails", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id,
      capabilities: ["project:list", "project:create"],
      allowed_project_ids: [],
    });
    mockListProjectSummaries.mockRejectedValue(
      new Error("account home unavailable"),
    );
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });
    const { default: handler } = await import("./get-one");
    await handler(req, res);
    expect(res._getJSONData()).toEqual({ error: "account home unavailable" });
    expect(mockGetProjects).not.toHaveBeenCalled();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("does not auto-create a project for project-list-only API keys", async () => {
    mockListProjectSummaries.mockResolvedValue({
      projects: [],
      next_offset: null,
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });

    const { default: handler } = await import("./get-one");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error:
        "No project is currently visible in the account index; retry later or explicitly create a project",
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("does not create from empty projections even with list and create capabilities", async () => {
    mockListProjectSummaries.mockResolvedValue({
      projects: [],
      next_offset: null,
    });
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id,
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:list", "project:create"],
      allowed_project_ids: [],
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {},
    });

    const { default: handler } = await import("./get-one");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error:
        "No project is currently visible in the account index; retry later or explicitly create a project",
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
    expect(mockGetProjects).not.toHaveBeenCalled();
  });
});
