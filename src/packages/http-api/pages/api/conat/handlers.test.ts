/** @jest-environment node */

import { createMocks } from "@cocalc/http-api/lib/api/test-framework";
import { conat } from "@cocalc/backend/conat";
import { getAccountFromApiKey } from "@cocalc/server/auth/api";
import hubBridge from "@cocalc/server/api/hub-bridge";
import projectBridge from "@cocalc/server/api/project-bridge";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import { assertApiKeyProjectMembership } from "@cocalc/server/api/project-membership-revocation";
jest.mock("@cocalc/server/api/project-membership-revocation", () => ({
  assertApiKeyProjectMembership: jest.fn(),
}));

import hubHandler from "./hub";
import { listProjectSummariesForApiKey } from "@cocalc/server/conat/api/projects";
jest.mock("@cocalc/server/conat/api/projects", () => ({
  listProjectSummariesForApiKey: jest.fn(),
}));
import projectHandler from "./project";

jest.mock("@cocalc/server/auth/api", () => ({
  getAccountFromApiKey: jest.fn(),
}));
jest.mock("@cocalc/backend/conat", () => ({
  conat: jest.fn(),
}));

jest.mock("@cocalc/server/api/hub-bridge", () => jest.fn());
jest.mock("@cocalc/server/api/project-bridge", () => jest.fn());
jest.mock("@cocalc/server/projects/is-collaborator", () => jest.fn());
jest.mock("@cocalc/server/api/api-key-audit", () => ({
  recordApiKeyAuditEventSoon: jest.fn(),
}));

const mockConat = jest.mocked(conat);
const mockGetAccountFromApiKey = jest.mocked(getAccountFromApiKey);
const mockHubBridge = jest.mocked(hubBridge);
const mockProjectBridge = jest.mocked(projectBridge);
const mockIsCollaborator = jest.mocked(isCollaborator);

describe("/api/conat/hub", () => {
  test("returns a structured summary rate denial without retry or account bridge fallback", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      capabilities: ["project:list"],
    } as any);
    jest.mocked(listProjectSummariesForApiKey).mockRejectedValue(
      Object.assign(new Error("remote rate exceeded"), {
        code: "api_search_rate_limited",
        retry_after_ms: 1250,
      }),
    );
    const { req, res } = createMocks({
      method: "POST",
      body: { name: "projects.listProjectSummaries", args: [{}] },
    });
    await hubHandler(req, res);
    expect(res.statusCode).toBe(429);
    expect(res.getHeader("Retry-After")).toBe("2");
    expect(res._getJSONData()).toEqual({
      error: "API search rate limit exceeded",
      code: "api_search_rate_limited",
      retry_after_ms: 1250,
    });
    expect(listProjectSummariesForApiKey).toHaveBeenCalledTimes(1);
    expect(mockHubBridge).not.toHaveBeenCalled();
  });
  test("summary dispatch preserves authenticated key context outside the account bridge", async () => {
    const principal = {
      account_id: "acc-1",
      key_id: "real-key",
      scope_revision: 3,
      capabilities: ["project:list"],
    } as any;
    mockGetAccountFromApiKey.mockResolvedValue(principal);
    const opts = {
      limit: 5,
      account_id: "victim",
      admission_key: { key_id: "victim-key", scope_revision: 1 },
    };
    jest
      .mocked(listProjectSummariesForApiKey)
      .mockResolvedValue({ projects: [], next_offset: null });
    const { req, res } = createMocks({
      method: "POST",
      body: { name: "projects.listProjectSummaries", args: [opts] },
    });
    await hubHandler(req, res);
    expect(listProjectSummariesForApiKey).toHaveBeenCalledWith(principal, opts);
    expect(mockHubBridge).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({ projects: [], next_offset: null });
  });
  beforeEach(() => {
    jest.resetAllMocks();
    mockConat.mockReturnValue({ id: "backend-client" } as any);
  });

  test("requires an account api key", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(undefined as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping" },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(res._getJSONData()).toEqual({
      error:
        "must be signed in and MUST provide an api key (cookies are not allowed)",
    });
  });
  test("waits for membership authorization before dispatching project RPC", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:read"],
      allowed_project_ids: ["proj-1"],
    } as any);
    jest
      .mocked(assertApiKeyProjectMembership)
      .mockRejectedValueOnce(Error("membership loss"));
    const { req, res } = createMocks({
      method: "POST",
      body: {
        name: "projects.getProjectState",
        args: [{ project_id: "proj-1" }],
      },
    });
    await hubHandler(req, res);
    expect(res._getJSONData()).toEqual({ error: "membership loss" });
    expect(mockHubBridge).not.toHaveBeenCalled();
  });

  test("bridges hub rpc calls for an authenticated account", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
    } as any);
    mockHubBridge.mockResolvedValue({ ok: true } as any);

    const { req, res } = createMocks({
      body: { args: [["acc-2"]], name: "system.getNames", timeout: 5000 },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(mockHubBridge).toHaveBeenCalledWith({
      client: { id: "backend-client" },
      account_id: "acc-1",
      args: [["acc-2"]],
      name: "system.getNames",
      timeout: 5000,
    });
    expect(res._getJSONData()).toEqual({ ok: true });
  });

  test("allows system ping for any authenticated account api key", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: [],
      allowed_project_ids: [],
    } as any);
    mockHubBridge.mockResolvedValue({ now: 123 } as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", timeout: 5000 },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(mockHubBridge).toHaveBeenCalledWith({
      client: { id: "backend-client" },
      account_id: "acc-1",
      args: [],
      name: "system.ping",
      timeout: 5000,
    });
    expect(res._getJSONData()).toEqual({ now: 123 });
  });

  test("denies unreviewed hub rpc calls for api keys", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["account:read"],
      allowed_project_ids: [],
    } as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.deleteAccount" },
      method: "POST",
      url: "/api/conat/hub",
    });

    await hubHandler(req, res);
    expect(mockHubBridge).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({
      error: "API keys are not allowed to call hub RPC 'system.deleteAccount'",
    });
  });
});

describe("/api/conat/project", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockConat.mockReturnValue({ id: "backend-client" } as any);
  });

  test("requires an account api key", async () => {
    mockGetAccountFromApiKey.mockResolvedValue(undefined as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(res._getJSONData()).toEqual({
      error: "must sign in with an account API key",
    });
  });

  test("requires account callers to be collaborators", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:exec"],
      allowed_project_ids: ["proj-1"],
    } as any);
    mockIsCollaborator.mockResolvedValue(false as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(mockIsCollaborator).toHaveBeenCalledWith({
      account_id: "acc-1",
      project_id: "proj-1",
    });
    expect(res._getJSONData()).toEqual({
      error: "user must be a collaborator on the project",
    });
  });

  test("bridges project rpc calls for account collaborators", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:exec"],
      allowed_project_ids: ["proj-1"],
    } as any);
    mockIsCollaborator.mockResolvedValue(true as any);
    mockProjectBridge.mockResolvedValue({ pong: true } as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(mockIsCollaborator).toHaveBeenCalledWith({
      account_id: "acc-1",
      project_id: "proj-1",
    });
    expect(mockProjectBridge).toHaveBeenCalledWith({
      client: { id: "backend-client" },
      args: [],
      name: "system.ping",
      project_id: "proj-1",
      timeout: undefined,
    });
    expect(res._getJSONData()).toEqual({ pong: true });
  });

  test("requires project exec capability for project bridge calls", async () => {
    mockGetAccountFromApiKey.mockResolvedValue({
      account_id: "acc-1",
      api_key_id: 1,
      key_id: "key-1",
      auth_method: "api_key",
      capabilities: ["project:read"],
      allowed_project_ids: ["proj-1"],
    } as any);

    const { req, res } = createMocks({
      body: { args: [], name: "system.ping", project_id: "proj-1" },
      method: "POST",
      url: "/api/conat/project",
    });

    await projectHandler(req, res);
    expect(mockIsCollaborator).not.toHaveBeenCalled();
    expect(mockProjectBridge).not.toHaveBeenCalled();
    expect(res._getJSONData()).toEqual({
      error:
        "API key lacks required capability 'project:exec' for project proj-1",
    });
  });
});
