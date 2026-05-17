export {};

let getBrowserCookieDomainForRequestMock: jest.Mock;
let getBrowserCookieNameForRequestMock: jest.Mock;

jest.mock("@cocalc/server/bay-public-origin", () => ({
  __esModule: true,
  getBrowserCookieDomainForRequest: (...args: any[]) =>
    getBrowserCookieDomainForRequestMock(...args),
  getBrowserCookieNameForRequest: (...args: any[]) =>
    getBrowserCookieNameForRequestMock(...args),
}));

describe("auth/clear-auth-cookies", () => {
  beforeEach(() => {
    jest.resetModules();
    getBrowserCookieDomainForRequestMock = jest.fn(async () => ".cocalc.ai");
    getBrowserCookieNameForRequestMock = jest.fn(async ({ name }) =>
      name === "remember_me" ? "alpha_cocalc_ai_remember_me" : name,
    );
  });

  it("clears host-only, legacy shared-domain, and namespaced shared-domain auth cookies", async () => {
    const clearCookie = jest.fn();
    const req = {};
    const res = { clearCookie };
    const { default: clearAuthCookies } = await import("./clear-auth-cookies");

    await clearAuthCookies({ req, res });

    expect(clearCookie.mock.calls).toEqual([
      ["remember_me", undefined],
      ["account_id", undefined],
      ["home_bay_id", undefined],
      ["remember_me", { domain: ".cocalc.ai" }],
      ["alpha_cocalc_ai_remember_me", { domain: ".cocalc.ai" }],
      ["account_id", { domain: ".cocalc.ai" }],
      ["home_bay_id", { domain: ".cocalc.ai" }],
    ]);
  });

  it("only clears host-only cookies when no shared browser domain exists", async () => {
    getBrowserCookieDomainForRequestMock = jest.fn(async () => undefined);
    const clearCookie = jest.fn();
    const req = {};
    const res = { clearCookie };
    const { default: clearAuthCookies } = await import("./clear-auth-cookies");

    await clearAuthCookies({ req, res });

    expect(clearCookie.mock.calls).toEqual([
      ["remember_me", undefined],
      ["account_id", undefined],
      ["home_bay_id", undefined],
    ]);
  });

  it("can clear only legacy un-namespaced shared-domain auth cookies", async () => {
    const clearCookie = jest.fn();
    const req = {};
    const res = { clearCookie };
    const { clearLegacySharedAuthCookies } =
      await import("./clear-auth-cookies");

    await clearLegacySharedAuthCookies({ req, res });

    expect(clearCookie.mock.calls).toEqual([
      ["remember_me", { domain: ".cocalc.ai" }],
      ["account_id", { domain: ".cocalc.ai" }],
      ["home_bay_id", { domain: ".cocalc.ai" }],
    ]);
  });
});
