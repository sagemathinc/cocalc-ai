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

describe("hub project-host proxy auth injection", () => {
  const project_id = "457f20dd-59d1-45c4-b5b1-a245d0e0a629";
  const host_id = "a0d9be5c-ffb3-46b3-8b42-1a676af96c13";
  const account_id = "126f0fec-85ee-4e0f-82d0-7c14a781911a";

  beforeEach(() => {
    jest.resetModules();
    mockProxyWeb.mockReset();
    mockProxyWs.mockReset();
    mockProxyOn.mockReset();
    mockGetPool.mockReset().mockReturnValue({
      query: jest.fn().mockResolvedValue({
        rows: [
          {
            host_id,
            internal_url: "http://project-host.internal:9911",
            public_url: null,
            metadata: {},
          },
        ],
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
});
