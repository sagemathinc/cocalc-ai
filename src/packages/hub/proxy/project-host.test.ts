/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockProxyWeb = jest.fn();
const mockProxyWs = jest.fn();
const mockProxyOn = jest.fn();
const mockGetPool = jest.fn();
const mockParseReq = jest.fn();
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

describe("proxyTargetForHost (054 C containment)", () => {
  const saved = process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
  });
  afterAll(() => {
    if (saved != null) process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = saved;
  });

  async function target(host: any): Promise<string> {
    const { proxyTargetForHost } = await import("./project-host");
    return proxyTargetForHost(host, "host x");
  }

  it("uses a valid tunnel port on this machine", async () => {
    expect(
      await target({ metadata: { self_host: { http_tunnel_port: 41000 } } }),
    ).toBe("http://127.0.0.1:41000");
    expect(
      await target({ metadata: { self_host: { http_tunnel_port: "41000" } } }),
    ).toBe("http://127.0.0.1:41000");
  });

  it("fails closed on a tunnel port that is not an integer port", async () => {
    for (const bad of ["127.0.0.1:22#", "80@evil.example", 22, 70000, 9.5, {}]) {
      await expect(
        target({
          internal_url: "http://10.0.0.5:9002",
          metadata: { self_host: { http_tunnel_port: bad } },
        }),
      ).rejects.toThrow("invalid tunnel port for host x");
    }
  });

  it("uses a stored host URL that names an ordinary address", async () => {
    expect(await target({ internal_url: "http://10.0.0.5:9002/" })).toBe(
      "http://10.0.0.5:9002",
    );
    expect(
      await target({ internal_url: null, public_url: "https://h.example" }),
    ).toBe("https://h.example");
  });

  it("fails closed on a stored host URL naming a refused address", async () => {
    for (const bad of [
      "http://127.0.0.1:5432",
      "http://localhost:9002",
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "http://2130706433/",
    ]) {
      await expect(target({ internal_url: bad })).rejects.toThrow(
        "not an allowed target",
      );
      await expect(target({ public_url: bad })).rejects.toThrow(
        "not an allowed target",
      );
    }
  });

  it("keeps a local self-host's internal_url fallback on the local route", async () => {
    expect(
      await target({
        internal_url: "http://127.0.0.1:9002",
        metadata: { machine: { cloud: "self-host" } },
      }),
    ).toBe("http://127.0.0.1:9002");
    await expect(
      target({ metadata: { machine: { cloud: "self-host" } } }),
    ).rejects.toThrow("local tunnel port missing for host x");
  });
});
