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
      agent: expect.any(Object),
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
      agent: expect.any(Object),
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
      agent: expect.any(Object),
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
      agent: expect.any(Object),
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
    if (saved != null)
      process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS = saved;
  });

  async function select(host: any) {
    const { proxyTargetForHost } = await import("./project-host");
    return proxyTargetForHost(host, "host x");
  }

  async function target(host: any): Promise<string> {
    return (await select(host)).target;
  }

  it("uses a valid tunnel port on this machine, with loopback allowed", async () => {
    expect(
      await select({ metadata: { self_host: { http_tunnel_port: 41000 } } }),
    ).toEqual({ target: "http://127.0.0.1:41000", allowLoopback: true });
    expect(
      await target({ metadata: { self_host: { http_tunnel_port: "41000" } } }),
    ).toBe("http://127.0.0.1:41000");
  });

  it("fails closed on a tunnel port that is not an integer port", async () => {
    for (const bad of [
      "127.0.0.1:22#",
      "80@evil.example",
      22,
      70000,
      9.5,
      {},
    ]) {
      await expect(
        target({
          internal_url: "http://10.0.0.5:9002",
          metadata: { self_host: { http_tunnel_port: bad } },
        }),
      ).rejects.toThrow("invalid tunnel port for host x");
    }
  });

  it("uses a stored host URL that names an ordinary address, with loopback NOT allowed", async () => {
    expect(await select({ internal_url: "http://10.0.0.5:9002/" })).toEqual({
      target: "http://10.0.0.5:9002",
      allowLoopback: false,
    });
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
      "http://[::ffff:7f00:1]/",
    ]) {
      await expect(target({ internal_url: bad })).rejects.toThrow(
        "not an allowed target",
      );
      await expect(target({ public_url: bad })).rejects.toThrow(
        "not an allowed target",
      );
    }
  });

  it("local-proxy branch: loopback internal_url allowed, never link-local or metadata (H2)", async () => {
    const local = { machine: { cloud: "self-host" } };
    expect(
      await select({ internal_url: "http://127.0.0.1:9002/", metadata: local }),
    ).toEqual({ target: "http://127.0.0.1:9002", allowLoopback: true });
    expect(
      await target({
        internal_url: "http://localhost:9002",
        metadata: { provider: "star" },
      }),
    ).toBe("http://localhost:9002");
    for (const bad of [
      "http://169.254.169.254/",
      "http://metadata.google.internal/",
      "http://0.0.0.0:9002",
      "http://[fe80::1]:9002",
      "ftp://127.0.0.1/",
      "http://u:p@127.0.0.1:9002",
    ]) {
      await expect(
        target({ internal_url: bad, metadata: local }),
      ).rejects.toThrow("not an allowed target");
    }
    await expect(target({ metadata: local })).rejects.toThrow(
      "local tunnel port missing for host x",
    );
  });
});

describe("hub project-host proxy dispatch (054 C R1)", () => {
  const project_id = "457f20dd-59d1-45c4-b5b1-a245d0e0a629";
  const host_id = "a0d9be5c-ffb3-46b3-8b42-1a676af96c13";
  let hostRow: any;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    mockProxyWeb.mockReset();
    mockProxyWs.mockReset();
    mockProxyOn.mockReset();
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
    mockIssueProjectHostAuthToken.mockReset().mockReturnValue({
      token: "t",
      expires_at: Date.now() + 60_000,
      claims: {},
    });
    mockGetProjectHostAuthTokenPrivateKey.mockReset().mockReturnValue("k");
  });

  function res() {
    return {
      headersSent: false,
      statusCode: 200,
      end: jest.fn(),
    } as any;
  }

  function socket() {
    return { destroyed: false, write: jest.fn(), destroy: jest.fn() } as any;
  }

  const refused = [
    "http://127.0.0.1:5432",
    "http://localhost:9002",
    "http://169.254.169.254/",
    "http://[::1]:9002",
  ];

  for (const type of ["proxy", "conat", "project-host-session"]) {
    it(`a refused stored URL never reaches proxy.web or proxy.ws (${type})`, async () => {
      mockParseReq.mockReturnValue({ type, project_id });
      const { createProjectHostProxyHandlers } = await import("./project-host");
      const handlers = await createProjectHostProxyHandlers();
      for (const url of refused) {
        hostRow = {
          host_id,
          internal_url: url,
          public_url: null,
          metadata: {},
        };
        const r = res();
        await handlers.handleRequest(
          { url: `/${project_id}/x`, headers: {} },
          r,
        );
        expect(r.statusCode).toBe(404);
        const s = socket();
        await handlers.handleUpgrade(
          { url: `/${project_id}/x`, headers: {} },
          s,
          Buffer.alloc(0),
        );
        expect(s.destroy).toHaveBeenCalled();
      }
      expect(mockProxyWeb).not.toHaveBeenCalled();
      expect(mockProxyWs).not.toHaveBeenCalled();
    });
  }

  it("a conat route naming a HOST id is checked too (targetForConatHost)", async () => {
    // the route id is the host id: getHostById finds the row directly
    mockParseReq.mockReturnValue({ type: "conat", project_id: host_id });
    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    hostRow = {
      host_id,
      internal_url: "http://169.254.169.254/",
      public_url: null,
      metadata: {},
    };
    const r = res();
    await handlers.handleRequest({ url: `/${host_id}/conat/`, headers: {} }, r);
    expect(r.statusCode).toBe(404);
    expect(mockProxyWeb).not.toHaveBeenCalled();
  });

  it("an ordinary proxied request uses the tunnel port first (the same rule as conat)", async () => {
    mockParseReq.mockReturnValue({ type: "proxy", project_id });
    hostRow = {
      host_id,
      internal_url: "http://10.0.0.5:9002",
      public_url: null,
      metadata: { self_host: { http_tunnel_port: 41000 } },
    };
    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();
    await handlers.handleRequest(
      { url: `/${project_id}/x`, headers: {} },
      res(),
    );
    expect(mockProxyWeb.mock.calls[0][2].target).toBe("http://127.0.0.1:41000");
  });

  it("passes a guarded agent: strict for a stored URL, loopback-only-literal for the tunnel", async () => {
    const http = await import("node:http");
    const probe = (agent: any, url: string): Promise<string> =>
      new Promise((resolve) => {
        const req = http.get(url, { agent }, () => resolve("connected"));
        req.on("error", (err: any) => resolve(err.code));
      });
    mockParseReq.mockReturnValue({ type: "proxy", project_id });
    const { createProjectHostProxyHandlers } = await import("./project-host");
    const handlers = await createProjectHostProxyHandlers();

    hostRow = { host_id, internal_url: "http://10.0.0.5:9002", metadata: {} };
    await handlers.handleRequest(
      { url: `/${project_id}/x`, headers: {} },
      res(),
    );
    const strict = mockProxyWeb.mock.calls[0][2].agent;
    expect(strict.keepAlive).toBe(false);
    // the agent refuses loopback before any socket is opened
    expect(await probe(strict, "http://127.0.0.1:1/")).toBe(
      "ECOCALC_REFUSED_TARGET",
    );

    hostRow = {
      host_id,
      internal_url: null,
      metadata: { self_host: { http_tunnel_port: 41000 } },
    };
    // a fresh module: host rows are cached per project
    jest.resetModules();
    const fresh = await (
      await import("./project-host")
    ).createProjectHostProxyHandlers();
    const s = socket();
    await fresh.handleUpgrade(
      { url: `/${project_id}/x`, headers: {} },
      s,
      Buffer.alloc(0),
    );
    const tunnel = mockProxyWs.mock.calls[0][3].agent;
    // loopback literal allowed: the connect is attempted (and refused by the OS)
    expect(await probe(tunnel, "http://127.0.0.1:1/")).toBe("ECONNREFUSED");
    // a link-local literal never is
    expect(await probe(tunnel, "http://169.254.169.254:1/")).toBe(
      "ECOCALC_REFUSED_TARGET",
    );
  });
});

describe("getProjectHostRedirectUrl (054 C)", () => {
  const project_id = "457f20dd-59d1-45c4-b5b1-a245d0e0a629";
  const host_id = "a0d9be5c-ffb3-46b3-8b42-1a676af96c13";
  const account_id = "126f0fec-85ee-4e0f-82d0-7c14a781911a";

  async function redirect(public_url: string) {
    jest.resetModules();
    delete process.env.COCALC_PROJECT_HOST_ALLOW_LOOPBACK_URLS;
    mockGetPool.mockReset().mockReturnValue({
      query: jest.fn(async () => ({
        rows: [{ host_id, public_url, internal_url: null, metadata: {} }],
      })),
    });
    mockIssueProjectHostAuthToken.mockReset().mockReturnValue({
      token: "tok",
      expires_at: Date.now() + 60_000,
      claims: {},
    });
    mockGetProjectHostAuthTokenPrivateKey.mockReset().mockReturnValue("k");
    const { getProjectHostRedirectUrl } = await import("./project-host");
    return await getProjectHostRedirectUrl({
      project_id,
      path: "/x",
      account_id,
    });
  }

  it("never sends a browser with a token to a refused address", async () => {
    for (const url of [
      "http://127.0.0.1:9002",
      "http://169.254.169.254",
      "http://localhost:9002",
    ]) {
      expect(await redirect(url)).toBeUndefined();
    }
    expect(mockIssueProjectHostAuthToken).not.toHaveBeenCalled();
    expect(await redirect("https://host-1.example.com")).toMatch(
      /^https:\/\/host-1\.example\.com\/x\?/,
    );
  });
});
