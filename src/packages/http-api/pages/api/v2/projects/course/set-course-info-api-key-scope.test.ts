/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockSetCourseInfo = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/projects/course/set-course-info", () => ({
  __esModule: true,
  default: (...args) => mockSetCourseInfo(...args),
}));

describe("/api/v2/projects/course/set-course-info API-key scope", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";
  const course = {
    project_id: "22222222-2222-4222-8222-222222222222",
    path: "course",
  };

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
    mockSetCourseInfo.mockReset().mockResolvedValue({ course });
  });

  it("requires project write capability for API-key course metadata updates", async () => {
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
      body: { project_id, course },
    });

    const { default: handler } = await import("./set-course-info");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'project:write' for project ${project_id}`,
    });
    expect(mockSetCourseInfo).not.toHaveBeenCalled();
  });

  it("allows API-key course metadata updates with project write capability and allowlist", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: { project_id, course },
    });

    const { default: handler } = await import("./set-course-info");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ course });
    expect(mockSetCourseInfo).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      course,
    });
  });
});
