import {
  buildProjectHostSessionCookie,
  buildProjectHostSessionCookieDeletion,
  legacyProjectHostCookiePath,
  projectCookiePath,
} from "./http-proxy-cookies";

jest.mock("./app-public-access", () => ({
  authorizePublicAppPath: jest.fn(async () => false),
}));

const getRowMock = jest.fn();
const getAccountRevokedBeforeMsMock = jest.fn(() => undefined);

jest.mock("@cocalc/lite/hub/sqlite/database", () => ({
  getRow: (...args: any[]) => getRowMock(...args),
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: (...args: any[]) =>
    getAccountRevokedBeforeMsMock(...args),
}));

import {
  createProjectHostHttpProxyAuth,
  createProjectHostHttpSessionToken,
  resolveProjectHostHttpSessionFromCookieHeader,
} from "./http-proxy-auth";
import { createProjectHostBrowserSessionToken } from "./browser-session";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";

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

describe("project-host HTTP session cookie", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";
  const account_id = "00000000-1000-4000-8000-000000000001";

  beforeEach(() => {
    getRowMock.mockReset();
    getRowMock.mockReturnValue({
      users: {
        [account_id]: { group: "owner" },
      },
    });
    getAccountRevokedBeforeMsMock.mockReset();
    getAccountRevokedBeforeMsMock.mockReturnValue(undefined);
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
});
