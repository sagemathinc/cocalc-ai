/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockProxyWeb = jest.fn();
const mockProxyWs = jest.fn();
const mockProxyOn = jest.fn();
const mockGetPool = jest.fn();
const mockParseReq = jest.fn();
const mockIsPublicAppSubdomainRequest = jest.fn();
const mockIssueProjectHostAuthToken = jest.fn();
const mockGetProjectHostAuthTokenPrivateKey = jest.fn();
const mockHandleFileDownload = jest.fn();
const mockIsWorkspaceProjectRuntime = jest.fn();

jest.mock("http-proxy-3", () => ({
  __esModule: true,
  default: {
    createProxyServer: jest.fn(() => ({
      on: mockProxyOn,
      web: mockProxyWeb,
      ws: mockProxyWs,
    })),
  },
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args) => mockGetPool(...args),
}));

jest.mock("./parse", () => ({
  parseReq: (...args) => mockParseReq(...args),
}));

jest.mock("./public-app-subdomain", () => ({
  isPublicAppSubdomainRequest: (...args) =>
    mockIsPublicAppSubdomainRequest(...args),
}));

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  issueProjectHostAuthToken: (...args) =>
    mockIssueProjectHostAuthToken(...args),
}));

jest.mock("@cocalc/backend/data", () => ({
  getProjectHostAuthTokenPrivateKey: (...args) =>
    mockGetProjectHostAuthTokenPrivateKey(...args),
}));

jest.mock("@cocalc/conat/files/file-download", () => ({
  handleFileDownload: (...args) => mockHandleFileDownload(...args),
}));

jest.mock("@cocalc/backend/conat", () => ({
  conat: () => ({ mock: "hub-conat-client" }),
}));

jest.mock("@cocalc/server/launchpad/project-runtime", () => ({
  isWorkspaceProjectRuntime: () => mockIsWorkspaceProjectRuntime(),
}));

describe("hub project-host proxy auth injection", () => {
  const project_id = "457f20dd-59d1-45c4-b5b1-a245d0e0a629";
  const host_id = "a0d9be5c-ffb3-46b3-8b42-1a676af96c13";
  const account_id = "126f0fec-85ee-4e0f-82d0-7c14a781911a";

  beforeEach(() => {
    jest.resetModules();
    mockProxyWeb.mockReset();
    mockProxyWs.mockReset();
    mockProxyOn.mockReset();
    const hostRow = {
      host_id,
      internal_url: "http://project-host.internal:9911",
      public_url: null,
      metadata: {},
    };
    mockGetPool.mockReset().mockReturnValue({
      query: jest.fn().mockImplementation(async (sql, params) => {
        const text = `${sql}`;
        const id = params?.[0];
        if (text.includes("FROM project_hosts") && id === host_id) {
          return { rows: [hostRow] };
        }
        if (text.includes("FROM projects") && id === project_id) {
          return { rows: [hostRow] };
        }
        return { rows: [] };
      }),
    });
    mockParseReq.mockReset().mockReturnValue({
      type: "proxy",
      project_id,
    });
    mockIsPublicAppSubdomainRequest.mockReset().mockReturnValue(false);
    mockIssueProjectHostAuthToken.mockReset().mockReturnValue({
      token: "project-host-token",
      expires_at: Date.now() + 60_000,
      claims: {},
    });
    mockGetProjectHostAuthTokenPrivateKey
      .mockReset()
      .mockReturnValue("private");
    mockHandleFileDownload.mockReset().mockResolvedValue(undefined);
    mockIsWorkspaceProjectRuntime.mockReset().mockReturnValue(false);
  });

  it("injects account-scoped project-host auth for proxied private requests", async () => {
    const { createProjectHostProxyHandlers, setProjectHostProxyAccountId } =
      await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = {
      url: `/${project_id}/proxy/12345/`,
      headers: {},
    };
    const res: any = {};
    setProjectHostProxyAccountId(req, account_id);

    await handlers.handleRequest(req, res);

    expect(mockIssueProjectHostAuthToken).toHaveBeenCalledWith({
      host_id,
      actor: "account",
      account_id,
      ttl_seconds: 5 * 60,
      private_key: "private",
    });
    expect(req.headers.authorization).toBe("Bearer project-host-token");
    expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
      target: "http://project-host.internal:9911",
      prependPath: false,
    });
  });

  it("serves files locally only for an existing workspace project", async () => {
    const hostlessRow = {
      // Legacy workspace projects may retain an obsolete assignment.
      host_id,
      internal_url: null,
      public_url: null,
      metadata: null,
    };
    mockGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [hostlessRow] }),
    });
    mockParseReq.mockReturnValue({ type: "files", project_id });
    mockIsWorkspaceProjectRuntime.mockReturnValue(true);

    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = { url: `/${project_id}/files/paper.pdf`, headers: {} };
    const res: any = {};

    await handlers.handleRequest(req, res);

    expect(mockHandleFileDownload).toHaveBeenCalledWith(
      expect.objectContaining({ req, res }),
    );
    expect(mockProxyWeb).not.toHaveBeenCalled();
  });

  it("does not use the local file service for unresolved hosted projects", async () => {
    const hostlessRow = {
      host_id: null,
      internal_url: null,
      public_url: null,
      metadata: null,
    };
    mockGetPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [hostlessRow] }),
    });
    mockParseReq.mockReturnValue({ type: "files", project_id });
    mockIsWorkspaceProjectRuntime.mockReturnValue(false);

    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = { url: `/${project_id}/files/paper.pdf`, headers: {} };
    const res: any = { headersSent: false, end: jest.fn() };

    await handlers.handleRequest(req, res);

    expect(mockHandleFileDownload).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.end).toHaveBeenCalledWith("Host not available");
  });

  it("proxies project-host browser session bootstrap through the routed project path", async () => {
    mockParseReq.mockReturnValue({
      type: "project-host-session",
      project_id,
    });

    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = {
      url: `/${project_id}/.cocalc/project-host/session`,
      headers: {
        authorization: "Bearer browser-session-token",
      },
    };
    const res: any = {};

    await handlers.handleRequest(req, res);

    expect(req.url).toBe("/.cocalc/project-host/session");
    expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
      target: "http://project-host.internal:9911",
      prependPath: false,
    });
  });

  it("injects account-scoped project-host auth for proxied project conat requests", async () => {
    mockParseReq.mockReturnValue({
      type: "conat",
      project_id,
    });

    const { createProjectHostProxyHandlers, setProjectHostProxyAccountId } =
      await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = {
      url: `/${project_id}/conat/?EIO=4&transport=polling`,
      headers: {},
    };
    const res: any = {};
    setProjectHostProxyAccountId(req, account_id);

    await handlers.handleRequest(req, res);

    expect(mockIssueProjectHostAuthToken).toHaveBeenCalledWith({
      host_id,
      actor: "account",
      account_id,
      ttl_seconds: 5 * 60,
      private_key: "private",
    });
    expect(req.headers.authorization).toBe("Bearer project-host-token");
    expect(req.url).toBe("/conat/?EIO=4&transport=polling");
    expect(mockProxyWeb).toHaveBeenCalledWith(req, res, {
      target: "http://project-host.internal:9911",
      prependPath: false,
    });
  });

  it("injects account-scoped project-host auth for proxied project conat websocket upgrades", async () => {
    mockParseReq.mockReturnValue({
      type: "conat",
      project_id,
    });

    const { createProjectHostProxyHandlers, setProjectHostProxyAccountId } =
      await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    const req: any = {
      url: `/${project_id}/conat/?EIO=4&transport=websocket`,
      headers: {},
    };
    const socket: any = {};
    const head: any = Buffer.alloc(0);
    setProjectHostProxyAccountId(req, account_id);

    await handlers.handleUpgrade(req, socket, head);

    expect(mockIssueProjectHostAuthToken).toHaveBeenCalledWith({
      host_id,
      actor: "account",
      account_id,
      ttl_seconds: 5 * 60,
      private_key: "private",
    });
    expect(req.headers.authorization).toBe("Bearer project-host-token");
    expect(req.url).toBe("/conat/?EIO=4&transport=websocket");
    expect(mockProxyWs).toHaveBeenCalledWith(req, socket, head, {
      target: "http://project-host.internal:9911",
      prependPath: false,
    });
  });
});
