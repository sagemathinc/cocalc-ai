/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import { resolveProjectReferenceForMemberAllowRemote } from "@cocalc/server/conat/project-remote-access";
import { issueProjectHostApiKeyToken } from "@cocalc/server/api/project-host-api-key";
import { resolveHostConnection } from "@cocalc/server/conat/api/hosts";
import handler from "./project-host-api-key";

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: jest.fn(),
}));
jest.mock("@cocalc/server/conat/project-remote-access", () => ({
  resolveProjectReferenceForMemberAllowRemote: jest.fn(),
}));
jest.mock("@cocalc/server/api/project-host-api-key", () => ({
  issueProjectHostApiKeyToken: jest.fn(),
}));
jest.mock("@cocalc/server/conat/api/hosts", () => ({
  resolveHostConnection: jest.fn(),
}));

const account_id = "1ac58c19-f848-44cf-a761-f95b2bb9d878";
const granted_project_id = "a62650c1-23f7-4719-9017-cc9524fc6b7e";
const other_project_id = "e16c90e3-7a10-4837-b6a3-810e8701ac5a";
const host_id = "4863c350-244b-446b-b335-f18eae16c617";

describe("/api/conat/project-host-api-key", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(getAccountFromApiKey).mockResolvedValue({
      account_id,
      api_key_id: 1,
      key_id: "test-key-1234",
      auth_method: "api_key",
      capabilities: ["file:read"],
      allowed_project_ids: [granted_project_id],
      scope: {
        version: 1,
        account: ["project:list"],
        projects: [
          { project_id: granted_project_id, capabilities: ["file:read"] },
        ],
      },
      scope_revision: 1,
    });
  });

  test("does not resolve placement for a project outside the key grant", async () => {
    const { req, res } = createMocks({
      body: { project_id: other_project_id },
      method: "POST",
      url: "/api/conat/project-host-api-key",
    });

    await handler(req, res);

    expect(res._getJSONData()).toEqual({
      error: "API key does not grant project-host access to this project",
    });
    expect(resolveProjectReferenceForMemberAllowRemote).not.toHaveBeenCalled();
    expect(issueProjectHostApiKeyToken).not.toHaveBeenCalled();
    expect(resolveHostConnection).not.toHaveBeenCalled();
  });

  test("resolves placement after confirming a project data grant", async () => {
    jest.mocked(resolveProjectReferenceForMemberAllowRemote).mockResolvedValue({
      title: "Granted project",
      host_id,
    } as any);
    jest.mocked(issueProjectHostApiKeyToken).mockResolvedValue({
      host_id,
      token: "test-token",
      expires_at: 123,
    });
    jest.mocked(resolveHostConnection).mockResolvedValue({
      connect_url: "wss://test.invalid",
      local_proxy: false,
    } as any);
    const { req, res } = createMocks({
      body: { project_id: granted_project_id },
      method: "POST",
      url: "/api/conat/project-host-api-key",
    });

    await handler(req, res);

    expect(resolveProjectReferenceForMemberAllowRemote).toHaveBeenCalledWith({
      account_id,
      project_id: granted_project_id,
    });
    expect(issueProjectHostApiKeyToken).toHaveBeenCalledWith({
      account_id,
      key_id: "test-key-1234",
      scope_revision: 1,
      project_id: granted_project_id,
      host_id,
    });
    expect(res._getJSONData()).toEqual({
      project_id: granted_project_id,
      title: "Granted project",
      host_id,
      connect_url: "wss://test.invalid",
      local_proxy: false,
      token: "test-token",
      expires_at: 123,
    });
  });
});
