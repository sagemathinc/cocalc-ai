import {
  buildProjectHostBrowserSessionCookie,
  buildProjectHostBrowserSessionCookieDeletion,
  createProjectHostBrowserSessionToken,
  resolveProjectHostBrowserSessionFromCookieHeader,
} from "./browser-session";

describe("project-host shared browser session", () => {
  it("issues a host-wide secure session cookie", () => {
    const cookie = buildProjectHostBrowserSessionCookie({
      req: {
        headers: {
          "x-forwarded-proto": "https",
        },
        socket: {},
      } as any,
      sessionToken: "browser-session-token",
    });

    expect(cookie).toContain(
      "cocalc_project_host_session=browser-session-token; Path=/;",
    );
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("can delete the shared browser session cookie", () => {
    const cookie = buildProjectHostBrowserSessionCookieDeletion({
      req: {
        headers: {
          "x-forwarded-proto": "https",
        },
        socket: {},
      } as any,
    });

    expect(cookie).toContain("cocalc_project_host_session=");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Secure");
  });

  it("resolves the first valid shared browser session from a cookie header", () => {
    const valid = createProjectHostBrowserSessionToken({
      account_id: "00000000-1000-4000-8000-000000000001",
      now_ms: Date.now(),
    });
    const invalid = "stale-browser-session";
    const header = [
      `cocalc_project_host_session=${encodeURIComponent(valid)}`,
      `cocalc_project_host_session=${encodeURIComponent(invalid)}`,
    ].join("; ");

    const session = resolveProjectHostBrowserSessionFromCookieHeader(header);
    expect(session).toMatchObject({
      account_id: "00000000-1000-4000-8000-000000000001",
    });
  });
});
