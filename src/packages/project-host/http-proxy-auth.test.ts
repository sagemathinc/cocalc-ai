import { createHmac } from "node:crypto";
import { conatPassword } from "@cocalc/backend/data";
import {
  buildProjectHostSessionCookie,
  buildProjectHostSessionCookieDeletion,
  legacyProjectHostCookiePath,
  projectCookiePath,
} from "./http-proxy-cookies";

const getRowMock = jest.fn();
const getAccountRevokedBeforeMsMock = jest.fn(() => undefined);
const mockCallHub = jest.fn();
const mockGetMasterConatClient = jest.fn(() => ({ id: "master-client" }));
const mockVerifyProjectHostAuthToken = jest.fn();

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => getRowMock(...args),
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: (...args: any[]) =>
    getAccountRevokedBeforeMsMock(...args),
}));

jest.mock("@cocalc/conat/hub/call-hub", () => ({
  __esModule: true,
  default: (...args: any[]) => mockCallHub(...args),
}));

jest.mock("./master-status", () => ({
  getMasterConatClient: (...args: any[]) => mockGetMasterConatClient(...args),
}));

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (...args: any[]) =>
    mockVerifyProjectHostAuthToken(...args),
}));

jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: () => "test-public-key",
}));

import {
  clearProjectHostHttpProxyAuthCaches,
  createProjectHostHttpProxyAuth,
  createProjectHostHttpSessionToken,
  resolveProjectHostHttpSessionFromCookieHeader,
  verifyProjectHostHttpSessionToken,
} from "./http-proxy-auth";
import { EventEmitter } from "node:events";
import { createProjectHostBrowserSessionToken } from "./browser-session";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";
import {
  createPrivateAppHostnameRequestRewriter,
  PRIVATE_APP_HOST_HEADER,
} from "./private-app-hostname";

function createResponse() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: jest.fn((name: string) => headers.get(name)),
    setHeader: jest.fn((name: string, value: string | string[]) => {
      headers.set(name, value);
    }),
    headers,
  } as any;
}

function createLegacySessionToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", conatPassword)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

describe("project-host HTTP session cookie", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";
  const account_id = "00000000-1000-4000-8000-000000000001";

  beforeEach(() => {
    clearProjectHostHttpProxyAuthCaches();
    getRowMock.mockReset();
    getRowMock.mockReturnValue({
      users: {
        [account_id]: { group: "owner" },
      },
    });
    getAccountRevokedBeforeMsMock.mockReset();
    getAccountRevokedBeforeMsMock.mockReturnValue(undefined);
    mockCallHub.mockReset();
    mockGetMasterConatClient.mockReset();
    mockGetMasterConatClient.mockReturnValue({ id: "master-client" });
    mockVerifyProjectHostAuthToken.mockReset();
  });

  it("scopes the session cookie to the project path", () => {
    expect(projectCookiePath(project_id)).toBe(`/${project_id}`);

    const cookie = buildProjectHostSessionCookie({
      req: {
        headers: {
          "x-forwarded-proto": "https",
        },
        socket: {},
      } as any,
      sessionToken: "session-token",
      project_id,
    });

    expect(cookie).toContain(
      `cocalc_project_host_http_session=session-token; Path=/${project_id};`,
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("does not widen the cookie path or secure flag on plain http", () => {
    const cookie = buildProjectHostSessionCookie({
      req: {
        headers: {},
        socket: {},
      } as any,
      sessionToken: "session-token",
      project_id,
    });

    expect(cookie).toContain(`Path=/${project_id}`);
    expect(cookie).not.toContain("Path=/;");
    expect(cookie).not.toContain("Secure");
  });

  it("can delete the legacy broad-path session cookie", () => {
    const cookie = buildProjectHostSessionCookieDeletion({
      req: {
        headers: {
          "x-forwarded-proto": "https",
        },
        socket: {},
      } as any,
      path: legacyProjectHostCookiePath(),
    });

    expect(cookie).toContain("cocalc_project_host_http_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });

  it("accepts a valid scoped session cookie even if a stale legacy cookie is also present", () => {
    const valid = createProjectHostHttpSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const invalid = "stale-legacy-cookie";
    const header = [
      `cocalc_project_host_http_session=${encodeURIComponent(valid)}`,
      `cocalc_project_host_http_session=${encodeURIComponent(invalid)}`,
    ].join("; ");

    const session = resolveProjectHostHttpSessionFromCookieHeader(header);
    expect(session).toMatchObject({
      account_id,
    });
  });

  it("rejects pre-cutover full-lifetime HTTP session tokens", () => {
    const now_s = Math.floor(Date.now() / 1000);
    const legacyToken = createLegacySessionToken({
      account_id,
      iat: now_s,
      exp: now_s + 30 * 24 * 60 * 60,
      nonce: "33".repeat(12),
    });

    expect(
      verifyProjectHostHttpSessionToken(legacyToken, now_s * 1000),
    ).toBeUndefined();
  });

  it("does not refresh a pre-cutover browser session token", async () => {
    const now_s = Math.floor(Date.now() / 1000);
    const browserSession = createLegacySessionToken({
      account_id,
      iat: now_s,
      exp: now_s + 30 * 24 * 60 * 60,
      nonce: "44".repeat(12),
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;
    const res = createResponse();

    await expect(
      auth.authorizeHttpRequest(req, res, project_id),
    ).rejects.toThrow("missing project-host HTTP auth token");
    expect(res.headers.get("Set-Cookie")).toBeUndefined();
  });

  it("authorizes HTTP requests from the shared browser session cookie and mints a scoped HTTP session cookie", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        "x-forwarded-proto": "https",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;
    const res = createResponse();

    await auth.authorizeHttpRequest(req, res, project_id);

    const setCookie = res.headers.get("Set-Cookie");
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    expect(cookies.join("\n")).toContain("cocalc_project_host_http_session=");
    expect(cookies.join("\n")).toContain(`Path=/${project_id}`);
  });

  it("does not widen a bounded browser session when minting HTTP cookies", async () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T04:00:00.000Z");
      jest.setSystemTime(now);
      const auth = createProjectHostHttpProxyAuth({
        host_id: "00000000-1000-4000-8000-000000000099",
      });
      const browserSession = createProjectHostBrowserSessionToken({
        account_id,
        now_ms: now.getTime(),
        restricted_exp_s: Math.floor(now.getTime() / 1000) + 60,
      });
      const req = {
        headers: {
          cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
          "x-forwarded-proto": "https",
        },
        socket: {},
        url: `/${project_id}/apps/python-hello/`,
      } as any;
      const res = createResponse();

      await auth.authorizeHttpRequest(req, res, project_id);

      const setCookie = res.headers.get("Set-Cookie");
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      const issuedCookies = cookies.filter((cookie) =>
        `${cookie}`.includes("Max-Age=60"),
      );
      expect(issuedCookies).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("continues sliding ordinary browser sessions", async () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T04:00:00.000Z");
      jest.setSystemTime(now);
      const auth = createProjectHostHttpProxyAuth({
        host_id: "00000000-1000-4000-8000-000000000099",
      });
      const browserSession = createProjectHostBrowserSessionToken({
        account_id,
        now_ms: now.getTime() - 24 * 60 * 60 * 1000,
      });
      const req = {
        headers: {
          cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
          "x-forwarded-proto": "https",
        },
        socket: {},
        url: `/${project_id}/apps/python-hello/`,
      } as any;
      const res = createResponse();

      await auth.authorizeHttpRequest(req, res, project_id);

      const setCookie = res.headers.get("Set-Cookie");
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(
        cookies.filter((cookie) => `${cookie}`.includes("Max-Age=2592000")),
      ).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects an expired restricted bearer for HTTP requests", async () => {
    const now_s = Math.floor(Date.now() / 1000);
    mockVerifyProjectHostAuthToken.mockReturnValue({
      sub: account_id,
      act: "account",
      iat: now_s - 60,
      exp: now_s + 600,
      browser_session_exp_s: now_s - 1,
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: { authorization: "Bearer restricted-token" },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).rejects.toThrow("browser session authorization expired");
  });

  it("rejects agent bearers at HTTP session redemption", async () => {
    const now_s = Math.floor(Date.now() / 1000);
    mockVerifyProjectHostAuthToken.mockReturnValue({
      sub: account_id,
      act: "account",
      auth_actor: "agent",
      iat: now_s,
      exp: now_s + 600,
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: { authorization: "Bearer agent-token" },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).rejects.toThrow(
      "agent credentials cannot authorize project-host HTTP access",
    );
  });

  it("bounds cookies minted from a restricted bearer", async () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T04:00:00.000Z");
      jest.setSystemTime(now);
      const now_s = Math.floor(now.getTime() / 1000);
      mockVerifyProjectHostAuthToken.mockReturnValue({
        sub: account_id,
        act: "account",
        iat: now_s,
        exp: now_s + 600,
        browser_session_exp_s: now_s + 60,
      });
      const auth = createProjectHostHttpProxyAuth({
        host_id: "00000000-1000-4000-8000-000000000099",
      });
      const req = {
        headers: { authorization: "Bearer restricted-token" },
        socket: {},
        url: `/${project_id}/apps/python-hello/`,
      } as any;
      const res = createResponse();

      await auth.authorizeHttpRequest(req, res, project_id);

      const setCookie = res.headers.get("Set-Cookie");
      const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      expect(
        cookies.filter((cookie) => `${cookie}`.includes("Max-Age=60")),
      ).toHaveLength(2);
      const httpCookie = cookies.find(
        (cookie) =>
          `${cookie}`.startsWith("cocalc_project_host_http_session=") &&
          `${cookie}`.includes("Max-Age=60"),
      );
      expect(
        resolveProjectHostHttpSessionFromCookieHeader(`${httpCookie}`),
      ).toMatchObject({ restricted_exp_s: now_s + 60 });
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects an expired restricted bearer for websocket upgrades", async () => {
    const now_s = Math.floor(Date.now() / 1000);
    mockVerifyProjectHostAuthToken.mockReturnValue({
      sub: account_id,
      act: "account",
      iat: now_s - 60,
      exp: now_s + 600,
      browser_session_exp_s: now_s - 1,
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: { authorization: "Bearer restricted-token" },
      socket: {},
      url: `/${project_id}/apps/python-hello/socket`,
    } as any;

    await expect(auth.authorizeUpgradeRequest(req, project_id)).rejects.toThrow(
      "browser session authorization expired",
    );
  });

  it("does not forward bearer query tokens when a browser session cookie authorizes the request", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        "x-forwarded-proto": "https",
      },
      method: "GET",
      socket: {},
      url: `/${project_id}/apps/python-hello/?${PROJECT_HOST_HTTP_AUTH_QUERY_PARAM}=secret&x=1`,
    } as any;
    const res = createResponse();
    res.end = jest.fn();
    res.statusCode = 200;

    await auth.authorizeHttpRequest(req, res, project_id);

    expect(res.statusCode).toBe(302);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Location",
      `/${project_id}/apps/python-hello/?x=1`,
    );
    expect(res.end).toHaveBeenCalled();
  });

  it("keeps private-hostname token cleanup at the hostname root", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        host: "dev-1234.example.com",
        "x-forwarded-proto": "https",
      },
      method: "GET",
      socket: {},
      url: `/?${PROJECT_HOST_HTTP_AUTH_QUERY_PARAM}=secret`,
    } as any;
    const rewrite = createPrivateAppHostnameRequestRewriter({
      trace: async () => ({
        matched: true,
        project_id,
        app_id: "python-hello",
        base_path: "/apps/python-hello",
      }),
    });
    await rewrite(req);
    const res = createResponse();
    res.end = jest.fn();
    res.statusCode = 200;

    await auth.authorizeHttpRequest(req, res, project_id);

    expect(res.statusCode).toBe(302);
    expect(res.setHeader).toHaveBeenCalledWith("Location", "/");
    expect(res.end).toHaveBeenCalled();
  });

  it("serves non-download file previews without redirecting when a bearer query token is present", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        "x-forwarded-proto": "https",
      },
      method: "GET",
      socket: {},
      url: `/${project_id}/files/home/user/a.pdf?${PROJECT_HOST_HTTP_AUTH_QUERY_PARAM}=secret&x=1`,
    } as any;
    const res = createResponse();
    res.end = jest.fn();
    res.statusCode = 200;

    await auth.authorizeHttpRequest(req, res, project_id);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).not.toHaveBeenCalledWith(
      "Location",
      expect.anything(),
    );
    expect(res.end).not.toHaveBeenCalled();
    expect(req.url).toBe(`/${project_id}/files/home/user/a.pdf?x=1`);
  });

  it("authorizes websocket upgrades from the shared browser session cookie", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeUpgradeRequest(req, project_id),
    ).resolves.toMatchObject({
      account_id,
    });
  });

  it("never falls through to public HTTP authorization for a private hostname", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: {
        [PRIVATE_APP_HOST_HEADER]: "dev-abc.example.com",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).rejects.toThrow(
      "This private development site must be opened from its CoCalc project.",
    );
  });

  it("rejects retired public-app headers and query tokens without account auth", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: {
        "x-cocalc-public-app-host": "demo.example.invalid",
      },
      socket: {},
      url: `/${project_id}/apps/demo/?cocalc_app_token=retired`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).rejects.toThrow("missing project-host HTTP auth token");
    expect(req.url).toBe(`/${project_id}/apps/demo/`);
    expect(req.headers).not.toHaveProperty("x-cocalc-public-app-host");
  });

  it("authorizes a collaborator on a private hostname", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        [PRIVATE_APP_HOST_HEADER]: "dev-abc.example.com",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).resolves.toBeUndefined();
  });

  it("never falls through to public websocket authorization for a private hostname", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const req = {
      headers: {
        [PRIVATE_APP_HOST_HEADER]: "dev-abc.example.com",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(auth.authorizeUpgradeRequest(req, project_id)).rejects.toThrow(
      "This private development site must be opened from its CoCalc project.",
    );
  });

  it("denies a signed-in non-collaborator on a private hostname", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    getRowMock.mockReturnValue({ users: {} });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        [PRIVATE_APP_HOST_HEADER]: "dev-abc.example.com",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;

    await expect(
      auth.authorizeHttpRequest(req, createResponse(), project_id),
    ).rejects.toThrow(
      "permission denied: account is not a collaborator on this project",
    );
  });

  it("disconnects an upgraded collaborator socket after access is removed", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        [PRIVATE_APP_HOST_HEADER]: "dev-abc.example.com",
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/socket`,
    } as any;
    await auth.authorizeUpgradeRequest(req, project_id);

    const socket = new EventEmitter() as any;
    socket.destroyed = false;
    socket.destroy = jest.fn(() => {
      socket.destroyed = true;
    });
    auth.trackUpgradedSocket(req, socket);

    getRowMock.mockReturnValue({ users: {} });
    auth.clearCaches();
    const stop = auth.startUpgradeRevocationKickLoop();
    stop();

    expect(socket.destroy).toHaveBeenCalled();
  });

  it("disconnects an upgraded socket when its browser session expires", async () => {
    jest.useFakeTimers();
    try {
      const now = new Date("2026-09-19T04:00:00.000Z");
      jest.setSystemTime(now);
      const auth = createProjectHostHttpProxyAuth({
        host_id: "00000000-1000-4000-8000-000000000099",
      });
      const browserSession = createProjectHostBrowserSessionToken({
        account_id,
        now_ms: now.getTime(),
        restricted_exp_s: Math.floor(now.getTime() / 1000) + 1,
      });
      const req = {
        headers: {
          cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        },
        socket: {},
        url: `/${project_id}/apps/python-hello/socket`,
      } as any;
      await auth.authorizeUpgradeRequest(req, project_id);
      const socket = new EventEmitter() as any;
      socket.destroyed = false;
      socket.destroy = jest.fn(() => {
        socket.destroyed = true;
      });
      auth.trackUpgradedSocket(req, socket);

      jest.setSystemTime(new Date(now.getTime() + 2_000));
      const stop = auth.startUpgradeRevocationKickLoop();
      stop();

      expect(socket.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("strips bearer query tokens from websocket upgrade urls authorized by browser session cookie", async () => {
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
      },
      socket: {},
      url: `/${project_id}/apps/python-hello/?${PROJECT_HOST_HTTP_AUTH_QUERY_PARAM}=secret&x=1`,
    } as any;

    await expect(
      auth.authorizeUpgradeRequest(req, project_id),
    ).resolves.toMatchObject({
      account_id,
    });
    expect(req.url).toBe(`/${project_id}/apps/python-hello/?x=1`);
  });

  it("authorizes explicit public share file downloads for signed-in non-collaborators", async () => {
    const share_id = "00000000-1000-4000-8000-000000000042";
    const visitor_id = "00000000-1000-4000-8000-000000000043";
    getRowMock.mockReturnValue({ users: {} });
    mockCallHub.mockResolvedValue({
      project_id,
      share_id,
      read_policy: { rules: [{ action: "include", path: "public/**" }] },
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id: visitor_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        "x-forwarded-proto": "https",
      },
      method: "HEAD",
      socket: {},
      url: `/${project_id}/files/home/user/public/a.txt?download&viewer=1&share=${share_id}`,
    } as any;
    const res = createResponse();
    res.end = jest.fn();
    res.statusCode = 200;

    await auth.authorizeHttpRequest(req, res, project_id);

    expect(mockCallHub).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { id: "master-client" },
        name: "publicDirectoryShares.authorizeRead",
        args: [{ account_id: visitor_id, project_id, share_id }],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("authorizes inline public share file previews for signed-in non-collaborators", async () => {
    const share_id = "00000000-1000-4000-8000-000000000042";
    const visitor_id = "00000000-1000-4000-8000-000000000043";
    getRowMock.mockReturnValue({ users: {} });
    mockCallHub.mockResolvedValue({
      project_id,
      share_id,
      read_policy: { rules: [{ action: "include", path: "public/**" }] },
    });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id: visitor_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
        "x-forwarded-proto": "https",
      },
      method: "GET",
      socket: {},
      url: `/${project_id}/files/home/user/public/Figure4.html?viewer=1&share=${share_id}`,
    } as any;
    const res = createResponse();
    res.end = jest.fn();
    res.statusCode = 200;

    await auth.authorizeHttpRequest(req, res, project_id);

    expect(mockCallHub).toHaveBeenCalledWith(
      expect.objectContaining({
        client: { id: "master-client" },
        name: "publicDirectoryShares.authorizeRead",
        args: [{ account_id: visitor_id, project_id, share_id }],
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("does not let public share visitors access non-download project URLs", async () => {
    const visitor_id = "00000000-1000-4000-8000-000000000043";
    getRowMock.mockReturnValue({ users: {} });
    const auth = createProjectHostHttpProxyAuth({
      host_id: "00000000-1000-4000-8000-000000000099",
    });
    const browserSession = createProjectHostBrowserSessionToken({
      account_id: visitor_id,
      now_ms: Date.now(),
    });
    const req = {
      headers: {
        cookie: `cocalc_project_host_session=${encodeURIComponent(browserSession)}`,
      },
      method: "GET",
      socket: {},
      url: `/${project_id}/apps/python-hello/`,
    } as any;
    const res = createResponse();

    await expect(
      auth.authorizeHttpRequest(req, res, project_id),
    ).rejects.toThrow("permission denied");
    expect(mockCallHub).not.toHaveBeenCalled();
  });
});
