/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockStartProject = jest.fn();
const mockStopProject = jest.fn();
const mockCreateProject = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/conat/api/projects", () => ({
  __esModule: true,
  start: (...args) => mockStartProject(...args),
  stop: (...args) => mockStopProject(...args),
}));

jest.mock("@cocalc/server/projects/create", () => ({
  __esModule: true,
  default: (...args) => mockCreateProject(...args),
}));

jest.mock("@cocalc/server/api/api-key-audit", () => ({
  recordApiKeyAuditEventSoon: jest.fn(),
}));

describe("/api/v2/projects legacy control handlers", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:exec", "project:create"],
      allowed_project_ids: [project_id],
    });
    mockStartProject.mockReset().mockResolvedValue({ run_id: "run-1" });
    mockStopProject.mockReset().mockResolvedValue(undefined);
    mockCreateProject.mockReset().mockResolvedValue("project-new");
  });

  it("starts projects through the Conat admission path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      wait: false,
    });
  });

  it("stops projects through the Conat routing path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./stop");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockStopProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
    });
  });

  it("touch starts projects through the Conat admission path", async () => {
    const { req, res } = createMocks({
      method: "POST",
      body: { project_id },
    });

    const { default: handler } = await import("./touch");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({});
    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      wait: false,
    });
  });

  it("requires project exec capability for API-key project starts", async () => {
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

    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'project:exec' for project ${project_id}`,
    });
    expect(mockStartProject).not.toHaveBeenCalled();
  });

  it("allows API-key project starts with project exec capability and allowlist", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: { project_id },
    });

    const { default: handler } = await import("./start");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockStartProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      wait: false,
    });
  });

  it("requires project create capability for API-key project creation", async () => {
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
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { title: "Test", description: "Demo" },
    });

    const { default: handler } = await import("./create");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key lacks required capability 'project:create'",
    });
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("allows API-key project creation with project create capability", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { title: "Test", description: "Demo" },
    });

    const { default: handler } = await import("./create");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ project_id: "project-new" });
    expect(mockCreateProject).toHaveBeenCalledWith({
      account_id: "acct-1",
      title: "Test",
      description: "Demo",
    });
  });
});
