import {
  buildProjectHostBrowserSessionCookie,
  buildProjectHostBrowserSessionCookieDeletion,
  createProjectHostBrowserSessionToken,
  issueProjectHostBrowserSessionFromBearer,
  restrictedBrowserSessionTtlSeconds,
  resolveProjectHostBrowserSessionFromCookieHeader,
} from "./browser-session";

const mockVerifyProjectHostAuthToken = jest.fn();

jest.mock("@cocalc/conat/auth/project-host-token", () => ({
  verifyProjectHostAuthToken: (...args: any[]) =>
    mockVerifyProjectHostAuthToken(...args),
}));

jest.mock("./auth-public-key", () => ({
  getProjectHostAuthPublicKey: () => "test-public-key",
}));

jest.mock("./sqlite/account-revocations", () => ({
  getAccountRevokedBeforeMs: () => undefined,
}));

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

  it("uses SameSite=None for secure localhost-dev bootstrap origins", () => {
    const cookie = buildProjectHostBrowserSessionCookie({
      req: {
        headers: {
          "x-forwarded-proto": "https",
          origin: "http://localhost:9100",
          host: "host-fe625be4-c86f-4fc4-b324-fda2f895e448-lite4b.cocalc.ai",
        },
        socket: {},
      } as any,
      sessionToken: "browser-session-token",
    });

    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
  });

  it("uses SameSite=None for secure cross-origin hosted bootstrap requests", () => {
    const cookie = buildProjectHostBrowserSessionCookie({
      req: {
        headers: {
          "x-forwarded-proto": "https",
          origin: "https://lite4b.cocalc.ai",
          host: "host-fe625be4-c86f-4fc4-b324-fda2f895e448-lite4b.cocalc.ai",
        },
        socket: {},
      } as any,
      sessionToken: "browser-session-token",
    });

    expect(cookie).toContain("SameSite=None");
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

  it("bounds an exam browser session token and cookie to the requested ttl", () => {
    const now = Date.now();
    const token = createProjectHostBrowserSessionToken({
      account_id: "00000000-1000-4000-8000-000000000001",
      now_ms: now,
      ttl_seconds: 600,
    });
    expect(
      resolveProjectHostBrowserSessionFromCookieHeader(
        `cocalc_project_host_session=${encodeURIComponent(token)}`,
      ),
    ).toMatchObject({
      account_id: "00000000-1000-4000-8000-000000000001",
      iat_s: Math.floor(now / 1000),
      exp_s: Math.floor(now / 1000) + 600,
    });
    expect(
      buildProjectHostBrowserSessionCookie({
        req: {
          headers: {},
          socket: {},
        } as any,
        sessionToken: token,
        max_age_seconds: 600,
      }),
    ).toContain("Max-Age=600");
  });

  it("preserves a restricted session's absolute expiration", () => {
    expect(restrictedBrowserSessionTtlSeconds(4600, 1000)).toBe(3600);
    expect(restrictedBrowserSessionTtlSeconds(undefined, 1000)).toBeUndefined();
    expect(() => restrictedBrowserSessionTtlSeconds(1000, 1000)).toThrow(
      "browser session authorization expired",
    );

    const now = jest.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const token = createProjectHostBrowserSessionToken({
        account_id: "00000000-1000-4000-8000-000000000001",
        now_ms: Date.now(),
        restricted_exp_s: 1010,
      });
      expect(
        resolveProjectHostBrowserSessionFromCookieHeader(
          `cocalc_project_host_session=${encodeURIComponent(token)}`,
        ),
      ).toMatchObject({ exp_s: 1010, restricted_exp_s: 1010 });
    } finally {
      now.mockRestore();
    }
  });

  it("rejects agent bearers at browser-session redemption", () => {
    const now_s = Math.floor(Date.now() / 1000);
    mockVerifyProjectHostAuthToken.mockReturnValue({
      sub: "00000000-1000-4000-8000-000000000001",
      act: "account",
      auth_actor: "agent",
      iat: now_s,
      exp: now_s + 600,
    });

    expect(() =>
      issueProjectHostBrowserSessionFromBearer({
        req: { headers: {}, socket: {} } as any,
        res: createResponse(),
        host_id: "00000000-1000-4000-8000-000000000099",
        token: "agent-token",
      }),
    ).toThrow("agent credentials cannot create a browser session");
  });
});
