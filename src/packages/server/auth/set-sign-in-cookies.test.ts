export {};

let mockSetCookie: jest.Mock;
let mockClearLegacySharedAuthCookies: jest.Mock;
let mockCreateRememberMeCookie: jest.Mock;
let mockRecordNewAuthSession: jest.Mock;
let mockGetServerSettings: jest.Mock;
let mockGetBrowserCookieDomainForRequest: jest.Mock;
let mockGetBrowserCookieNameForRequest: jest.Mock;
let mockGetClusterAccountById: jest.Mock;

jest.mock("cookies", () =>
  jest.fn().mockImplementation(() => ({
    set: (...args: any[]) => mockSetCookie(...args),
  })),
);

jest.mock("./clear-auth-cookies", () => ({
  __esModule: true,
  clearLegacySharedAuthCookies: (...args: any[]) =>
    mockClearLegacySharedAuthCookies(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  __esModule: true,
  createRememberMeCookie: (...args: any[]) =>
    mockCreateRememberMeCookie(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  recordNewAuthSession: (...args: any[]) => mockRecordNewAuthSession(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  __esModule: true,
  getServerSettings: (...args: any[]) => mockGetServerSettings(...args),
}));

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  getBrowserCookieDomainForRequest: (...args: any[]) =>
    mockGetBrowserCookieDomainForRequest(...args),
  getBrowserCookieNameForRequest: (...args: any[]) =>
    mockGetBrowserCookieNameForRequest(...args),
}));

jest.mock("@cocalc/server/inter-bay/accounts", () => ({
  __esModule: true,
  getClusterAccountById: (...args: any[]) => mockGetClusterAccountById(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  __esModule: true,
  getConfiguredBayId: () => "bay-0",
}));

describe("auth/set-sign-in-cookies", () => {
  beforeEach(() => {
    jest.resetModules();
    mockSetCookie = jest.fn();
    mockClearLegacySharedAuthCookies = jest.fn(async () => undefined);
    mockCreateRememberMeCookie = jest.fn(async () => ({
      value: "remember-value",
      hash: "remember-hash",
      expire: new Date("2026-05-21T12:00:00Z"),
    }));
    mockRecordNewAuthSession = jest.fn(async () => undefined);
    mockGetServerSettings = jest.fn(async () => ({
      samesite_remember_me: "lax",
    }));
    mockGetBrowserCookieDomainForRequest = jest.fn(async () => ".cocalc.ai");
    mockGetBrowserCookieNameForRequest = jest.fn(async ({ name }) =>
      name === "remember_me" ? "lite4b_cocalc_ai_remember_me" : name,
    );
    mockGetClusterAccountById = jest.fn(async () => ({
      account_id: "11111111-1111-4111-8111-111111111111",
      home_bay_id: "bay-0",
    }));
  });

  it("sets shared-domain account and home-bay cookies for cross-bay sign-in redirects", async () => {
    const { default: setSignInCookies } = await import("./set-sign-in-cookies");

    await setSignInCookies({
      req: { protocol: "https", headers: { host: "bay-1-lite4b.cocalc.ai" } },
      res: {},
      account_id: "11111111-1111-4111-8111-111111111111",
      home_bay_id: "bay-1",
      maxAge: 60_000,
    });

    expect(mockClearLegacySharedAuthCookies).toHaveBeenCalled();
    expectCookie("remember_me", "remember-value");
    expectCookie("lite4b_cocalc_ai_remember_me", "remember-value", {
      domain: ".cocalc.ai",
    });
    expectCookie("account_id", "11111111-1111-4111-8111-111111111111");
    expectCookie("account_id", "11111111-1111-4111-8111-111111111111", {
      domain: ".cocalc.ai",
    });
    expectCookie("home_bay_id", "bay-1");
    expectCookie("home_bay_id", "bay-1", { domain: ".cocalc.ai" });
    expect(mockRecordNewAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({
        password_verified_at: undefined,
        factor_verified_at: undefined,
        fresh_auth_until: undefined,
      }),
    );
  });

  it("records password verification only when the caller supplies it", async () => {
    const { default: setSignInCookies } = await import("./set-sign-in-cookies");
    const authenticated_at = new Date("2026-06-20T12:00:00Z");

    await setSignInCookies({
      req: { protocol: "https", headers: { host: "bay-1-lite4b.cocalc.ai" } },
      res: {},
      account_id: "11111111-1111-4111-8111-111111111111",
      session: {
        authenticated_at,
        password_verified_at: authenticated_at,
        factor_verified_at: null,
        factor_level: "none",
        fresh_auth_until: null,
      },
    });

    expect(mockRecordNewAuthSession).toHaveBeenCalledWith(
      expect.objectContaining({
        authenticated_at,
        password_verified_at: authenticated_at,
        factor_verified_at: null,
        factor_level: "none",
        fresh_auth_until: null,
      }),
    );
  });
});

function expectCookie(
  name: string,
  value: string,
  opts: { domain?: string } = {},
) {
  expect(
    mockSetCookie.mock.calls.some(([actualName, actualValue, actualOpts]) => {
      return (
        actualName === name &&
        actualValue === value &&
        actualOpts?.domain === opts.domain
      );
    }),
  ).toBe(true);
}
