/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";

const mockGetAccountId = jest.fn();
const mockGetAccountFromApiKey = jest.fn();
const mockIsCollaborator = jest.fn();
const mockGetProxiedPublicPathInfo = jest.fn();
const mockWriteFile = jest.fn();
const mockCp = jest.fn();
const mockConat = jest.fn();
const mockFilesystemClient = jest.fn();

jest.mock("@cocalc/http-api/lib/account/get-account", () => ({
  __esModule: true,
  default: (...args) => mockGetAccountId(...args),
}));

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: (...args) => mockGetAccountFromApiKey(...args),
}));

jest.mock("@cocalc/server/projects/is-collaborator", () => ({
  __esModule: true,
  default: (...args) => mockIsCollaborator(...args),
}));

jest.mock(
  "@cocalc/http-api/lib/share/proxy/get-proxied-public-path-info",
  () => ({
    __esModule: true,
    default: (...args) => mockGetProxiedPublicPathInfo(...args),
  }),
);

jest.mock("@cocalc/backend/conat", () => ({
  conat: (...args) => mockConat(...args),
}));

jest.mock("@cocalc/conat/files/file-server", () => ({
  client: (...args) => mockFilesystemClient(...args),
}));

describe("/api/v2/projects file-copy API-key scope", () => {
  const sourceProjectId = "11111111-1111-4111-8111-111111111111";
  const targetProjectId = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    mockGetAccountId.mockReset().mockResolvedValue("acct-1");
    mockGetAccountFromApiKey.mockReset().mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["file:read", "file:write"],
      allowed_project_ids: [sourceProjectId, targetProjectId],
    });
    mockIsCollaborator.mockReset().mockResolvedValue(true);
    mockGetProxiedPublicPathInfo.mockReset().mockResolvedValue({
      contents: { content: "data" },
    });
    mockWriteFile.mockReset().mockResolvedValue(undefined);
    mockCp.mockReset().mockResolvedValue(undefined);
    mockConat.mockReset().mockReturnValue({
      fs: () => ({ writeFile: mockWriteFile }),
    });
    mockFilesystemClient.mockReset().mockReturnValue({ cp: mockCp });
  });

  it("requires file write capability for API-key URL copy", async () => {
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
      body: {
        project_id: targetProjectId,
        url: "https://example.com/data.txt",
      },
    });

    const { default: handler } = await import("./copy-url");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'file:write' for project ${targetProjectId}`,
    });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("allows API-key URL copy with file write capability", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {
        project_id: targetProjectId,
        url: "https://example.com/data.txt",
      },
    });

    const { default: handler } = await import("./copy-url");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({});
    expect(mockWriteFile).toHaveBeenCalledWith("data.txt", "data");
  });

  it("requires file read and write capabilities for API-key project copy", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acct-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["file:read"],
      allowed_project_ids: [sourceProjectId],
    });
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {
        src_project_id: sourceProjectId,
        target_project_id: targetProjectId,
        path: "source.txt",
      },
    });

    const { default: handler } = await import("./copy-path");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: `API key lacks required capability 'file:write' for project ${targetProjectId}`,
    });
    expect(mockCp).not.toHaveBeenCalled();
  });

  it("allows API-key project copy with source read and target write", async () => {
    const { req, res } = createMocks({
      method: "POST",
      headers: { Authorization: "Bearer cocalc_api_key_test" },
      body: {
        src_project_id: sourceProjectId,
        target_project_id: targetProjectId,
        path: "source.txt",
        target_path: "target.txt",
      },
    });

    const { default: handler } = await import("./copy-path");
    await handler(req, res);

    expect(res._getJSONData()).toEqual({ status: "ok" });
    expect(mockCp).toHaveBeenCalledWith({
      src: { project_id: sourceProjectId, path: "source.txt" },
      dest: { project_id: targetProjectId, path: "target.txt" },
      options: { timeout: undefined, recursive: true },
    });
  });
});
