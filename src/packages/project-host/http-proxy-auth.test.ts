import {
  buildProjectHostSessionCookie,
  buildProjectHostSessionCookieDeletion,
  legacyProjectHostCookiePath,
  projectCookiePath,
} from "./http-proxy-cookies";

jest.mock("./app-public-access", () => ({
  authorizePublicAppPath: jest.fn(async () => false),
}));

import {
  createProjectHostHttpSessionToken,
  resolveProjectHostHttpSessionFromCookieHeader,
} from "./http-proxy-auth";

describe("project-host HTTP session cookie", () => {
  const project_id = "00000000-1000-4000-8000-000000000000";

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
      account_id: "00000000-1000-4000-8000-000000000001",
      now_ms: Date.now(),
    });
    const invalid = "stale-legacy-cookie";
    const header = [
      `cocalc_project_host_http_session=${encodeURIComponent(valid)}`,
      `cocalc_project_host_http_session=${encodeURIComponent(invalid)}`,
    ].join("; ");

    const session = resolveProjectHostHttpSessionFromCookieHeader(header);
    expect(session).toMatchObject({
      account_id: "00000000-1000-4000-8000-000000000001",
    });
  });
});
