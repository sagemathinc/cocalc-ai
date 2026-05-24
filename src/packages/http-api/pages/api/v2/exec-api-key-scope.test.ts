/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockExec = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/projects/exec", () => ({
  __esModule: true,
  default: (...args) => mockExec(...args),
}));

describe("/api/v2/exec API-key scope", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:exec"],
      allowed_project_ids: [project_id],
    });
    mockExec.mockReset().mockResolvedValue({
      type: "blocking",
      stdout: "ok\n",
      stderr: "",
      exit_code: 0,
    });
  });

  it("requires project exec capability for API-key command execution", async () => {
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
      body: {
        project_id,
        command: "echo",
        args: ["ok"],
      },
    });

    const { default: handler } = await import("./exec");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'project:exec' for project ${project_id}`,
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("allows API-key command execution with project exec capability and allowlist", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: {
        Authorization: "Bearer cocalc_api_key_test",
        "Content-Type": "application/json",
      },
      body: {
        project_id,
        command: "echo",
        args: ["ok"],
      },
    });

    const { default: handler } = await import("./exec");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      type: "blocking",
      stdout: "ok\n",
      stderr: "",
      exit_code: 0,
    });
    expect(mockExec).toHaveBeenCalledWith({
      account_id: "acct-1",
      project_id,
      execOpts: {
        filesystem: undefined,
        path: undefined,
        command: "echo",
        args: ["ok"],
        timeout: 60,
        max_output: undefined,
        bash: undefined,
        aggregate: undefined,
        err_on_exit: undefined,
        env: undefined,
        async_call: undefined,
        async_get: undefined,
        async_stats: undefined,
        async_await: undefined,
      },
    });
  });
});
